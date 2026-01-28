// src/app/component/class-view/class-view.component.ts
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  BehaviorSubject,
  combineLatest,
  firstValueFrom,
  interval,
  of,
  Subscription,
  timer,
} from 'rxjs';
import { switchMap, map, shareReplay } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import {
  ClassMessage,
  ClassSection,
  CourseModule,
  Lesson,
  QuizAttempt,
  QuizQuestion,
} from 'src/app/model/user';
import { CourseService } from 'src/app/shared/course.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { MessageService } from 'src/app/shared/message.service';
import { AngularFireStorage } from '@angular/fire/compat/storage';
import { DataService } from 'src/app/shared/data.service';
import { AngularFirestore } from '@angular/fire/compat/firestore';
// 1) Add these types + helpers at the top of the class (after existing fields)
type AvgStats = {
  pct: number | null;
  gradedCount: number; // number of graded items considered
  assignmentsCount?: number; // total assignments (for "your" average)
  attemptsCount?: number; // total attempts (for class average)
  totalCorrect: number;
  totalQuestions: number;
};
// Make a concrete type the builder uses internally
type EditorQuestion = Omit<QuizQuestion, 'kind'> & {
  // Whatever your model defines for kind (keeps it in sync)
  kind: NonNullable<QuizQuestion['kind']>;
  imageUrl?: string;
  correct?: number;
  correctMulti?: number[];
  correctText?: string;
};

@Component({
  selector: 'app-class',
  templateUrl: './class.component.html',
  styleUrls: ['./class.component.css'],
})
export class ClassComponent implements OnInit {
  builderOpen = false;
  builderTitle = '';
  builderPoints: number | null = null;
  deleting: Record<string, boolean> = {};

  builderEditingId: string | null = null;

  editingQuizId: string | null = null; // when set, builder is editing an existing quiz
  forkSourceId: string | null = null;
  forkBusy = false;
  forkError = '';

  addReadingOpen = false;
  reading = {
    title: '',
    linkUrl: '',
    file: null as File | null,
  };
  readingBusy = false;
  readingError = '';

  // class.component.ts (inside class)
  attemptLimitOpen = false;
  attemptLimit = { used: 0, max: 0 };

  // class.component.ts
  builderMaxAttempts: number | null = null;

  builderTimed = false;
  builderTimeMin: number | null = null;

  confirmStartOpen = false;
  pendingStartClassId: string | null = null;

  inviteMode: 'email' | 'username' = 'email';

  inviteU = {
    username: '',
    role: 'student' as 'student' | 'instructor' | 'ta',
  };
  invitingU = false;

  builderAudience: 'all' | 'subset' = 'all';
  builderAssignees = new Set<string>();

  assigneeQuery$ = new BehaviorSubject<string>('');
  assigneeQuery = '';

  // one “draft” question editor
  draft: {
    kind: 'mcq-single' | 'mcq-multi' | 'text';
    prompt: string;
    choices: string[]; // used for mcq kinds
    correctSingle: number | null;
    correctMulti: Set<number>;
    correctText: string;
    imageUrl: string; // remote URL (optional)
    imageFile?: File | null; // picked local file
    imagePreviewUrl?: string; // blob: preview
  } = this.newDraft();
  onPickImage(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    // cleanup previous preview
    if (this.draft.imagePreviewUrl)
      URL.revokeObjectURL(this.draft.imagePreviewUrl);
    this.draft.imageFile = file;
    this.draft.imagePreviewUrl = URL.createObjectURL(file);
  }
  // builderQuestions: QuizQuestion[] = [];
  builderQuestions: EditorQuestion[] = [];

  newDraft() {
    return {
      kind: 'mcq-single' as const,
      prompt: '',
      choices: ['', ''],
      correctSingle: null,
      correctMulti: new Set<number>(),
      correctText: '',
      imageUrl: '', // NEW
    };
  }

  classId$ = this.route.paramMap.pipe(map((p) => p.get('id')!));

  me$ = this.auth.user$;

  class$ = this.classId$.pipe(switchMap((id) => this.classes.class$(id)));

  role$ = combineLatest([this.classId$, this.auth.user$]).pipe(
    switchMap(([id, me]) => this.classes.memberRole$(id, me?.uid))
  );
  messages$ = this.classId$.pipe(
    switchMap((id) => this.msg.messagesForClass$(id, 100)),
    map((list) =>
      list.map((m) => ({
        ...m,
        createdAtDate: m.createdAt?.toDate ? m.createdAt.toDate() : new Date(0),
      }))
    )
  );

  // Accordion state: all closed by default
  sectionOpen: Record<
    'assignments' | 'readings' | 'messages' | 'participants',
    boolean
  > = {
    assignments: false,
    readings: false,
    messages: false,
    participants: false,
  };

  toggleSection(key: 'assignments' | 'readings' | 'messages' | 'participants') {
    this.sectionOpen[key] = !this.sectionOpen[key];
  }

  newMessageTxt = '';
  sendingMsg = false;
  msgError = '';

  highlightMsgId = '';
  private msgNavSub?: Subscription;

  course$ = this.class$.pipe(
    switchMap((cl) =>
      cl?.courseId ? this.courses.get$(cl.courseId) : of(undefined)
    )
  );
  // NEW: pending invites stream
  invites$ = this.classId$.pipe(
    switchMap((id) => this.classes.pendingInvites$(id))
  );
  modules$ = this.class$.pipe(
    switchMap((cl) =>
      cl?.courseId
        ? this.courses.modules$(cl.courseId)
        : of([] as CourseModule[])
    )
  );

  members$ = this.classId$.pipe(
    switchMap((id) => this.classes.membersWithUsers$(id))
  );

  instructor$ = this.class$.pipe(
    switchMap((cl) =>
      cl?.instructorId ? this.classes.user$(cl.instructorId) : of(null)
    )
  );

  // invite form state
  invite = { email: '', role: 'student' as 'student' | 'instructor' | 'ta' };
  inviting = false;

  // remove state
  removing: Record<string, boolean> = {};
  canceling: Record<string, boolean> = {}; // NEW: cancel pending invite
  // QUIZ state/streams
  // REPLACE your current `assignments$` with these two streams:

  assignmentsAll$ = this.classId$.pipe(
    switchMap((id) => this.asgn.assignments$(id))
  );
  quizTemplates$ = this.assignmentsAll$.pipe(
    map((list) => (list ?? []).filter((a: any) => a?.type === 'quiz'))
  );

  assignments$ = combineLatest([
    this.assignmentsAll$,
    this.me$,
    this.role$,
  ]).pipe(
    map(([list, me, role]) => {
      if (role === 'instructor' || role === 'ta') return list;
      const uid = me?.uid;
      return (list ?? []).filter(
        (a: any) =>
          (a?.audience ?? 'all') !== 'subset' ||
          (Array.isArray(a?.assignedTo) && a.assignedTo.includes(uid))
      );
    })
  );

  // use a BehaviorSubject so the stream re-computes when you open another assignment
  openAssignmentId$ = new BehaviorSubject<string | null>(null);
  openAssignmentId: string | null = null; // keep for template if you use it

  attemptsMap$ = combineLatest([
    this.classId$,
    this.me$,
    this.assignments$,
  ]).pipe(
    switchMap(([classId, me, assigns]) => {
      if (!me?.uid || !assigns?.length)
        return of({} as Record<string, QuizAttempt | null>);
      const calls = assigns.map((a) =>
        this.asgn.attempt$(classId, a.id!, me.uid!)
      );
      return combineLatest(calls).pipe(
        map((atts) => {
          const map: Record<string, QuizAttempt | null> = {};
          assigns.forEach((a, i) => (map[a.id!] = atts[i] ?? null));
          return map;
        })
      );
    })
  );

  myAttempt$ = combineLatest([
    this.classId$,
    this.me$,
    this.openAssignmentId$,
  ]).pipe(
    switchMap(([classId, me, aid]) => {
      if (!aid || !me?.uid) return of(null);
      return this.asgn.attempt$(classId, aid, me.uid);
    })
  );
  // Attempts for the currently-open assignment (instructor/TA only)
  isTeacher$ = this.role$.pipe(map((r) => r === 'instructor' || r === 'ta'));

  instructorAttempts$ = combineLatest([
    this.isTeacher$,
    this.classId$,
    this.openAssignmentId$,
  ]).pipe(
    switchMap(([ok, classId, aid]) =>
      ok && classId && aid
        ? this.asgn.attemptsForAssignment$(classId, aid)
        : of([])
    )
  );

  students$ = this.members$.pipe(
    map((list) => (list ?? []).filter((m) => (m as any)?.role === 'student'))
  );
  filteredStudents$ = combineLatest([this.students$, this.assigneeQuery$]).pipe(
    map(([list, q]) => {
      const t = (q || '').toLowerCase();
      if (!t) return list;
      return list.filter((m) => {
        const fn = (m.user?.firstName || '').toLowerCase();
        const ln = (m.user?.lastName || '').toLowerCase();
        const em = (m.user?.email || m.uid).toLowerCase();
        return fn.includes(t) || ln.includes(t) || em.includes(t);
      });
    })
  );

  onAssigneeSearch(v: string) {
    this.assigneeQuery = v;
    this.assigneeQuery$.next(v);
  }
  toggleAssignee(uid: string, checked: boolean) {
    if (checked) this.builderAssignees.add(uid);
    else this.builderAssignees.delete(uid);
  }
  isAssignee(uid: string) {
    return this.builderAssignees.has(uid);
  }
  // ALL attempts for the open assignment (NOT deduped)
  instructorAttemptsAll$ = combineLatest([
    this.isTeacher$,
    this.classId$,
    this.openAssignmentId$,
  ]).pipe(
    switchMap(([ok, classId, aid]) =>
      ok && classId && aid
        ? this.asgn.attemptsForAssignmentAll$(classId, aid) // must return full history
        : of([])
    )
  );
  lessons$ = this.classId$.pipe(
    switchMap((classId) =>
      classId
        ? this.afs
            .collection<Lesson>(`classes/${classId}/lessons`)
            .valueChanges({ idField: 'id' })
        : of([] as Lesson[])
    ),
    // latest first: by createdAt desc, fallback to order desc
    map((list) =>
      [...list].sort(
        (a, b) =>
          this.ms(b.createdAt) - this.ms(a.createdAt) ||
          (b.order ?? 0) - (a.order ?? 0)
      )
    ),
    shareReplay(1)
  );

  private ms(x: any): number {
    if (!x) return 0;
    if (x instanceof Date) return x.getTime();
    const t = (x as any)?.toDate?.();
    return t instanceof Date ? t.getTime() : typeof x === 'number' ? x : 0;
  }

  instructorAttemptRows$ = combineLatest([
    this.instructorAttemptsAll$, // all per-user attempt docs for the open quiz
    this.members$,
  ]).pipe(
    map(([all, members]) => {
      const userByUid = new Map(members.map((m) => [m.uid, m.user]));

      // If duplicates ever appear, keep the one with the newest updatedAt
      const byUid = new Map<string, any>();
      for (const a of all as any[]) {
        const prev = byUid.get(a.uid);
        const prevTs = prev?.updatedAt?.toDate?.()?.getTime?.() ?? 0;
        const currTs = a?.updatedAt?.toDate?.()?.getTime?.() ?? 0;
        if (!prev || currTs >= prevTs) byUid.set(a.uid, a);
      }

      return Array.from(byUid.values()).map((a: any) => ({
        ...a,
        user: userByUid.get(a.uid) || null,
        attemptCount: this.computeDisplayAttemptCount(a), // <- the chip shows this
        // (Optional: expose raw values for debugging tooltips)
        _rawAttemptCount:
          typeof a.attemptCount === 'number' ? a.attemptCount : null,
        _historyLen: Array.isArray(a.history) ? a.history.length : null,
        _status: a.status,
      }));
    })
  );

  private computeDisplayAttemptCount(a: any): number {
    // 1) Submitted runs from different sources (some older docs may have only one of these)
    const fieldCount = typeof a?.attemptCount === 'number' ? a.attemptCount : 0;
    const histLen = Array.isArray(a?.history) ? a.history.length : 0;
    const maxAttemptNo =
      Array.isArray(a?.history) && a.history.length
        ? Math.max(
            ...a.history.map((h: any) =>
              typeof h?.attemptNo === 'number' ? h.attemptNo : 0
            )
          )
        : 0;

    // 2) Evidence that *at least one* submission happened even if counters were never written
    const hasAnySubmitted =
      a?.status === 'submitted' ||
      a?.status === 'expired' ||
      a?.score != null ||
      !!a?.submittedAt;

    // 3) Base submitted count = the strongest of all sources (plus 1 if we only have “evidence”)
    const submitted = Math.max(
      fieldCount,
      histLen,
      maxAttemptNo,
      hasAnySubmitted ? 1 : 0
    );

    // 4) Count an in-progress retake that isn’t included in the submitted total yet
    const lastSubmittedMs = Array.isArray(a?.history)
      ? a.history.reduce(
          (m: number, h: any) =>
            Math.max(m, h?.submittedAt?.toDate?.()?.getTime?.() ?? 0),
          0
        )
      : 0;
    const startedMs = a?.startedAt?.toDate?.()?.getTime?.() ?? 0;
    const hasFreshUnsubmittedRun =
      a?.status === 'in-progress' && startedMs > lastSubmittedMs;

    // Extra fallback: if the doc is in-progress (or has answers) but submitted==0, count it as 1
    const hasAnyAnswers =
      Array.isArray(a?.answers) &&
      a.answers.some(
        (ans: any) =>
          (typeof ans === 'number' && ans >= 0) ||
          (Array.isArray(ans) && ans.length > 0) ||
          (typeof ans === 'string' && ans.trim().length > 0)
      );

    const addInProgress =
      hasFreshUnsubmittedRun ||
      (submitted === 0 && (a?.status === 'in-progress' || hasAnyAnswers));

    return submitted + (addInProgress ? 1 : 0);
  }

  attemptCounts$ = combineLatest([
    this.isTeacher$,
    this.classId$,
    this.assignments$,
  ]).pipe(
    switchMap(([ok, classId, assigns]) => {
      if (!ok || !classId || !assigns?.length)
        return of({} as Record<string, number>);
      const streams = assigns.map((a) =>
        this.asgn
          .attemptsForAssignment$(classId, a.id!)
          .pipe(map((list) => list.length))
      );
      return combineLatest(streams).pipe(
        map((counts) => {
          const m: Record<string, number> = {};
          assigns.forEach((a, i) => (m[a.id!] = counts[i] || 0));
          return m;
        })
      );
    })
  );

  constructor(
    private route: ActivatedRoute,
    private auth: AuthService,
    private classes: ClassService,
    private courses: CourseService,
    private asgn: AssignmentService, // QUIZ,
    private msg: MessageService,
    private storage: AngularFireStorage,
    public data: DataService,
    private afs: AngularFirestore
  ) {}

  /** Map a % to your grade color; fallback to neutral when missing */
  private gradeColor(pct: number | null): string {
    if (pct == null || isNaN(pct)) return 'rgb(203, 213, 225)'; // slate-300
    return this.data.getGradientColor(pct);
  }

  /** Donut ring using your grade color for the filled arc */
  conicGrade(pct: number | null) {
    const p = Math.max(0, Math.min(100, pct ?? 0));
    const fill = this.gradeColor(pct);
    const rest = 'rgb(226, 232, 240)'; // slate-200
    return `conic-gradient(${fill} 0% ${p}%, ${rest} ${p}% 100%)`;
  }

  /** Progress bar inline styles: width + solid grade color */
  barStyle(pct: number | null) {
    const w = Math.max(0, Math.min(100, pct ?? 0));
    return {
      width: `${w}%`,
      background: this.gradeColor(pct),
    };
  }
  ngOnInit() {
    combineLatest([this.classId$, this.me$]).subscribe(
      async ([classId, me]) => {
        if (classId && me?.uid) await this.msg.markClassSeen(me.uid, classId);
      }
    );
    //  Deep-link handling: scroll to a specific message and highlight it
    this.msgNavSub = this.route.queryParamMap.subscribe((params) => {
      const mid = params.get('msg');
      if (!mid) return;
      this.highlightMsgId = mid;

      const sub = this.messages$.subscribe((list) => {
        if (!list.some((m) => m.id === mid)) return;
        // wait a tick for DOM
        setTimeout(() => {
          document.getElementById('msg-' + mid)?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        }, 80);
        setTimeout(() => (this.highlightMsgId = ''), 2000);
        sub.unsubscribe();
      });
    });

    // One sub that drives lock + auto-submit using the live counter
    this.tickerSub = combineLatest([
      this.timeLeft$,
      this.myAttempt$,
      this.openAssignmentId$,
      this.assignments$,
      this.classId$,
    ]).subscribe(async ([secs, att, aid, assigns, classId]) => {
      if (!aid) {
        this.lockTimed = false;
        return;
      }

      const current: any = this.getById(assigns, aid);
      const isTimed = !!current?.timed && att?.score == null && secs !== null;

      this.lockTimed = isTimed && secs! > 0;

      // Auto-submit exactly once when it hits 0
      if (isTimed && secs === 0 && this.lastAutoSubmitAid !== aid) {
        this.lastAutoSubmitAid = aid;
        try {
          await this.submit(classId);
        } catch {}
      }
    });

    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }
  ngOnDestroy() {
    this.msgNavSub?.unsubscribe();
    this.tickerSub?.unsubscribe();
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
  }

  private beforeUnloadHandler = (e: BeforeUnloadEvent) => {
    if (this.lockTimed) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  async inviteMember(classId: string) {
    const email = this.invite.email?.trim();
    if (!email) return;

    this.inviting = true;
    try {
      // avoid inviting yourself (optional but nice)
      const me = await firstValueFrom(this.auth.user$);
      if (me?.email && me.email.toLowerCase() === email.toLowerCase()) {
        alert('Vous ne pouvez pas vous inviter vous-même.');
        return;
      }

      // 👉 use the dashboard behavior here
      const uidOrNull = await this.classes.inviteByEmailOrCreatePending(
        classId,
        email,
        this.invite.role
      );

      // If uidOrNull is a uid, the member list updates.
      // If null, a pending invite was created and invites$ updates.

      this.invite.email = '';
      this.invite.role = 'student';
    } catch (e: any) {
      alert(e?.message || 'Erreur lors de l’invitation');
    } finally {
      this.inviting = false;
    }
  }
  async removeMember(classId: string, uid: string, label?: string) {
    const who = (label || uid || 'cet utilisateur').trim();
    if (!confirm(`Retirer ${who} de cette classe ?`)) return;

    this.removing[uid] = true;
    try {
      await this.classes.removeMember(classId, uid);
    } catch (e: any) {
      alert(e?.message || 'Erreur lors du retrait');
    } finally {
      delete this.removing[uid];
    }
  }

  // NEW: cancel a pending invite
  async removeInvite(classId: string, inviteId: string) {
    this.canceling[inviteId] = true;
    try {
      await this.classes.cancelInvite(classId, inviteId);
    } finally {
      delete this.canceling[inviteId];
    }
  }

  trackById(_: number, x: any) {
    return x?.id || x?.uid;
  }

  // --- handlers ---
  async addQuickQuiz(clId: string) {
    const me = await firstValueFrom(this.me$);
    if (!me?.uid) return;
    await this.asgn.createQuickQuiz(clId, me.uid);
  }

  openAssignment(aid: string) {
    this.openAssignmentId = aid;
    this.openAssignmentId$.next(aid); // <-- trigger myAttempt$ updates
  }

  async startAttempt(classId: string) {
    const me = await firstValueFrom(this.me$);
    const aid = this.openAssignmentId;
    if (!me?.uid || !aid) return;
    await this.asgn.startAttemptIfNeeded(classId, aid, me.uid);
  }

  async selectAnswer(classId: string, idx: number, choice: number) {
    const me = await firstValueFrom(this.me$);
    const aid = this.openAssignmentId;
    if (!me?.uid || !aid) return;
    await this.asgn.saveAnswer(classId, aid, me.uid, idx, choice);
  }

  async submit(classId: string) {
    const me = await firstValueFrom(this.me$);
    const aid = this.openAssignmentId;
    if (!me?.uid || !aid) return;
    await this.asgn.submitAndGrade(classId, aid, me.uid);
    alert('Soumis. Note enregistrée.');
  }
  // class.component.ts (inside ClassComponent)
  getById<T extends { id: string }>(
    arr: T[] | null | undefined,
    id: string | null | undefined
  ): T | null {
    if (!arr || !id) return null;
    return arr.find((x) => x.id === id) ?? null;
  }
  async confirmDeleteAssignment(classId: string, assignmentId: string) {
    const ok = confirm('Supprimer ce quiz ? Cette action est définitive.');
    if (!ok) return;

    this.deleting[assignmentId] = true;
    try {
      // Close the panel if we're deleting the open one
      if (this.openAssignmentId === assignmentId) {
        this.openAssignmentId = null;
        this.openAssignmentId$.next(null);
      }
      await this.asgn.deleteAssignment(classId, assignmentId);
    } finally {
      delete this.deleting[assignmentId];
    }
  }
  answeredCount(att: QuizAttempt | null | undefined): number {
    if (!att?.answers?.length) return 0;
    return att.answers.filter((n) => n != null && n >= 0).length;
  }
  scorePct(
    att: QuizAttempt | null | undefined,
    total: number | undefined
  ): number {
    if (att?.score == null || !total) return 0;
    return Math.round((att.score / total) * 100);
  }
  toggleAssignment(aid: string) {
    if (this.lockTimed) return; // NEW: lock while timed
    if (this.openAssignmentId === aid) {
      this.openAssignmentId = null;
      this.openAssignmentId$.next(null);
    } else {
      this.openAssignmentId = aid;
      this.openAssignmentId$.next(aid);
    }
  }

  closeAssignment() {
    if (this.lockTimed) return; // NEW
    if (this.openAssignmentId !== null) {
      this.openAssignmentId = null;
      this.openAssignmentId$.next(null);
    }
  }

  trackByIndex(i: number, _item: unknown) {
    return i;
  }

  onChoiceChange(i: number, val: string) {
    this.draft.choices[i] = val; // mutate in place so the array reference stays stable
  }

  /** From the dropdown; null = close */
  onOpenSelect(val: string | null) {
    const id = val ?? null;
    this.openAssignmentId = id;
    this.openAssignmentId$.next(id);
  }

  addChoice() {
    this.draft.choices.push('');
  }

  removeChoice(i: number) {
    this.draft.choices.splice(i, 1);
    // maintain correctness sets
    if (this.draft.kind === 'mcq-single' && this.draft.correctSingle === i) {
      this.draft.correctSingle = null;
    }
    if (this.draft.kind === 'mcq-multi') {
      this.draft.correctMulti.delete(i);
    }
  }

  toggleCorrectMulti(i: number) {
    if (this.draft.correctMulti.has(i)) this.draft.correctMulti.delete(i);
    else this.draft.correctMulti.add(i);
  }

  removeBuilderQuestion(qid: string) {
    this.builderQuestions = this.builderQuestions.filter((q) => q.id !== qid);
  }

  // ====== ANSWER HANDLERS for new kinds (student) ======
  async selectAnswerSingle_New(classId: string, idx: number, choice: number) {
    const me = await firstValueFrom(this.me$);
    if (!me?.uid || !this.openAssignmentId) return;
    await this.asgn.saveAnswerSingle(
      classId,
      this.openAssignmentId,
      me.uid,
      idx,
      choice
    );
  }

  async toggleAnswerMulti_New(classId: string, idx: number, choice: number) {
    const me = await firstValueFrom(this.me$);
    if (!me?.uid || !this.openAssignmentId) return;
    await this.asgn.toggleAnswerMulti(
      classId,
      this.openAssignmentId,
      me.uid,
      idx,
      choice
    );
  }

  async saveAnswerText_New(classId: string, idx: number, text: string) {
    const me = await firstValueFrom(this.me$);
    if (!me?.uid || !this.openAssignmentId) return;
    await this.asgn.saveAnswerText(
      classId,
      this.openAssignmentId,
      me.uid,
      idx,
      text
    );
  }
  private pct(totalCorrect: number, totalQuestions: number): number | null {
    return totalQuestions > 0
      ? Math.round((totalCorrect / totalQuestions) * 100)
      : null;
  }

  /** Pretty conic ring for the donut */
  conic(pct: number | null) {
    if (pct == null || isNaN(pct)) {
      return `conic-gradient(rgb(226 232 240) 0% 100%)`;
    }
    const p = Math.max(0, Math.min(100, pct));
    return `conic-gradient(
    rgb(79 70 229) 0% ${p}%,
    rgb(203 213 225) ${p}% 100%
  )`;
  }
  barWidth(pct: number | null) {
    const p = Math.max(0, Math.min(100, pct ?? 0));
    return `${p}%`;
  }

  // 2) Your (current user) average for this class
  myClassAvg$ = combineLatest([
    this.classId$,
    this.me$,
    this.assignments$,
  ]).pipe(
    switchMap(([classId, me, assigns]) => {
      if (!me?.uid || !assigns?.length) {
        return of<AvgStats>({
          pct: null,
          gradedCount: 0,
          assignmentsCount: assigns?.length ?? 0,
          totalCorrect: 0,
          totalQuestions: 0,
        });
      }
      const streams = assigns.map((a) =>
        this.asgn.attempt$(classId, a.id!, me.uid!)
      );
      return combineLatest(streams).pipe(
        map((atts) => {
          let totalCorrect = 0;
          let totalQuestions = 0;
          let gradedCount = 0;

          assigns.forEach((a, i) => {
            const att = atts[i];
            const qTotal =
              (a as any)?.numQuestions ??
              (Array.isArray(att?.answers) ? att!.answers.length : 0);
            if (att?.score != null && qTotal > 0) {
              totalCorrect += att.score;
              totalQuestions += qTotal;
              gradedCount++;
            }
          });

          return {
            pct: this.pct(totalCorrect, totalQuestions),
            gradedCount,
            assignmentsCount: assigns.length,
            totalCorrect,
            totalQuestions,
          } as AvgStats;
        })
      );
    })
  );

  // 3) Class average (instructor/TA only)
  classAvg$ = combineLatest([
    this.isTeacher$,
    this.classId$,
    this.assignments$,
  ]).pipe(
    switchMap(([ok, classId, assigns]) => {
      if (!ok || !assigns?.length) {
        return of<AvgStats | null>(null);
      }
      const streams = assigns.map((a) =>
        this.asgn.attemptsForAssignment$(classId, a.id!)
      );
      return combineLatest(streams).pipe(
        map((listPerAssignment) => {
          let totalCorrect = 0;
          let totalQuestions = 0;
          let gradedCount = 0; // number of graded attempts
          let attemptsCount = 0; // total attempts (graded + not graded)

          assigns.forEach((a, i) => {
            const attempts = listPerAssignment[i] || [];
            const qTotal = (a as any)?.numQuestions ?? 0;
            attemptsCount += attempts.length;
            attempts.forEach((att) => {
              if (att?.score != null && qTotal > 0) {
                totalCorrect += att.score;
                totalQuestions += qTotal;
                gradedCount++;
              }
            });
          });

          return {
            pct: this.pct(totalCorrect, totalQuestions),
            gradedCount,
            attemptsCount,
            totalCorrect,
            totalQuestions,
          } as AvgStats;
        })
      );
    })
  );

  async sendClassMessage() {
    this.msgError = '';
    const text = this.newMessageTxt.trim();
    if (!text) return;

    this.sendingMsg = true;
    try {
      const classId = await firstValueFrom(this.classId$);
      const me = await firstValueFrom(this.me$);
      if (!classId || !me?.uid) {
        this.msgError = 'Non authentifié.';
        return;
      }

      await this.msg.sendMessage(classId, text);
      this.newMessageTxt = '';
      await this.msg.markClassSeen(me.uid, classId);
    } catch (e: any) {
      this.msgError = e?.message || 'Échec de l’envoi.';
      console.error('[class] send message failed:', e);
    } finally {
      this.sendingMsg = false;
    }
  }

  async addByUsername(classId: string) {
    const username = this.inviteU.username?.trim();
    if (!username) return;

    this.invitingU = true;
    try {
      // optional: avoid adding yourself
      const me = await firstValueFrom(this.auth.user$);
      if (
        me?.displayName &&
        me.displayName.toLowerCase() === username.toLowerCase()
      ) {
        alert('Vous ne pouvez pas vous ajouter vous-même.');
        return;
      }

      await this.classes.addMemberByUsername(
        classId,
        username,
        this.inviteU.role
      );

      // reset
      this.inviteU.username = '';
      this.inviteU.role = 'student';
      alert('Membre ajouté à la classe ✅');
    } catch (e: any) {
      alert(e?.message || 'Impossible d’ajouter ce nom d’utilisateur.');
    } finally {
      this.invitingU = false;
    }
  }

  private async uploadQuestionImage(
    classId: string,
    quizId: string,
    qid: string,
    file: File
  ): Promise<string> {
    const ext = file.name.split('.').pop() || 'jpg';
    const path = `classes/${classId}/quizzes/${quizId}/questions/${qid}.${ext}`;
    const task = this.storage.upload(path, file);
    await task;
    const ref = this.storage.ref(path);
    return await firstValueFrom(ref.getDownloadURL());
  }
  // class.component.ts -> saveCustomQuiz(...)
  async saveCustomQuiz(classId: string) {
    const me = await firstValueFrom(this.me$);
    if (!me?.uid) return;
    if (!this.builderTitle.trim()) {
      alert('Titre du quiz requis');
      return;
    }
    if (!this.builderQuestions.length) {
      alert('Ajoutez des questions');
      return;
    }

    // timed
    let timeLimitSec: number | undefined;
    if (this.builderTimed) {
      const m = Math.max(1, Math.floor(this.builderTimeMin ?? 0));
      if (!m) {
        alert('Durée invalide');
        return;
      }
      timeLimitSec = m * 60;
    }

    // upload images (unchanged)
    const quizId = crypto?.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    const questions: any[] = [];
    for (const q of this.builderQuestions) {
      const qq: any = { ...q };
      if ((q as any).__file) {
        const url = await this.uploadQuestionImage(
          classId,
          quizId,
          q.id,
          (q as any).__file
        );
        qq.imageUrl = url;
        delete qq.__file;
      }
      questions.push(qq);
    }

    // NEW: recipients
    const audience = this.builderAudience;
    const assignedTo =
      audience === 'subset' ? Array.from(this.builderAssignees) : [];
    const maxAttemptsNum = Number(this.builderMaxAttempts);
    const maxAttempts =
      Number.isFinite(maxAttemptsNum) && maxAttemptsNum > 0
        ? Math.floor(maxAttemptsNum)
        : 10000;

    await this.asgn.createCustomQuiz(
      classId,
      me.uid,
      this.builderTitle.trim(),
      questions,
      this.builderPoints ?? undefined,
      {
        timed: this.builderTimed,
        timeLimitSec,
        audience,
        assignedTo,
        maxAttempts,
      }
    );

    // reset
    this.builderTitle = '';
    this.builderPoints = null;
    this.builderQuestions = [];
    this.builderTimed = false;
    this.builderTimeMin = null;
    this.builderAudience = 'all';
    this.builderAssignees.clear();
    this.assigneeQuery = '';
    this.assigneeQuery$.next('');
    this.builderOpen = false;
    this.builderMaxAttempts = null;
    this.forkSourceId = null;
    this.forkError = '';
    this.forkBusy = false;
  }

  lockTimed = false;
  timeLeft$ = combineLatest([
    this.myAttempt$,
    this.openAssignmentId$,
    this.assignments$,
  ]).pipe(
    switchMap(([att, aid, assigns]) => {
      if (!aid) return of(null);
      const current: any = this.getById(assigns, aid);
      if (!current?.timed) return of(null);

      const expires = (att as any)?.expiresAt?.toDate?.() as Date | undefined;
      if (!expires) return of(null);

      // Recompute every second
      return timer(0, 1000).pipe(
        map(() =>
          Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))
        )
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private tickerSub?: Subscription;
  private lastAutoSubmitAid: string | null = null;

  clock(sec: number) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      r = s % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
      : `${m}:${r.toString().padStart(2, '0')}`;
  }
  onStartClick(classId: string, current: any, att: QuizAttempt | null) {
    // NEW: cap first
    if (this.reachedLimit(att, current)) {
      this.openAttemptLimit(att, current);
      return;
    }

    // Untimed: same behavior
    if (!current?.timed) {
      this.startAttempt(classId);
      return;
    }

    // Timed (unchanged below)
    if (att?.status === 'submitted' || att?.status === 'expired') return;
    if (att?.startedAt) return;
    this.pendingStartClassId = classId;
    this.confirmStartOpen = true;
  }

  async confirmStart(classId: string) {
    this.confirmStartOpen = false;
    await this.startAttempt(classId);
    this.pendingStartClassId = null;
  }

  // Return an ordered list of targets with graceful fallbacks (name/email/uid)
  assignedList(
    asg: any,
    members: Array<{ uid: string; user?: any }>
  ): Array<{ uid: string; name: string; email?: string }> {
    if (!asg) return [];
    const uids: string[] =
      (Array.isArray(asg?.assignedToUids) && asg.assignedToUids) ||
      (Array.isArray(asg?.assignedTo) && asg.assignedTo) ||
      [];
    const emailsLower: string[] =
      (Array.isArray(asg?.assignedToEmailsLower) &&
        asg.assignedToEmailsLower) ||
      [];

    const byUid = new Map<string, any>(
      (members || []).map((m) => [m.uid, m?.user || null])
    );

    const out: Array<{ uid: string; name: string; email?: string }> = [];

    // First: all UID targets (prefer full name, then email, then uid)
    for (const uid of uids) {
      const u = byUid.get(uid);
      const name =
        [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() ||
        u?.displayName ||
        u?.email ||
        uid;
      out.push({ uid, name, email: u?.email });
    }

    // Then: any pure email targets not covered by UID
    for (const e of emailsLower) {
      const already = out.some((x) => (x.email || '').toLowerCase() === e);
      if (!already) {
        out.push({ uid: `email:${e}`, name: e, email: e });
      }
    }

    return out;
  }

  initials(name: string): string {
    return (name || '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => (s[0] || '').toUpperCase())
      .join('');
  }

  trackByUid(_: number, x: any) {
    return x?.uid || x;
  }

  public usedAttempts(att: any): number {
    // exact same implementation as in QuizTakeComponent
    const field = typeof att?.attemptCount === 'number' ? att.attemptCount : 0;
    const histLen = Array.isArray(att?.history) ? att.history.length : 0;
    const maxNo = Array.isArray(att?.history)
      ? Math.max(
          0,
          ...att.history.map((h: any) =>
            typeof h?.attemptNo === 'number' ? h.attemptNo : 0
          )
        )
      : 0;
    const hasAnySubmitted =
      att?.status === 'submitted' ||
      att?.status === 'expired' ||
      att?.score != null ||
      !!att?.submittedAt;
    const submitted = Math.max(field, histLen, maxNo, hasAnySubmitted ? 1 : 0);
    const lastSubmittedMs = Array.isArray(att?.history)
      ? att.history.reduce(
          (m: number, h: any) =>
            Math.max(m, h?.submittedAt?.toDate?.()?.getTime?.() ?? 0),
          0
        )
      : 0;
    const startedMs = att?.startedAt?.toDate?.()?.getTime?.() ?? 0;
    const hasFreshUnsubmittedRun =
      att?.status === 'in-progress' && startedMs > lastSubmittedMs;

    const hasAnyAnswers =
      Array.isArray(att?.answers) &&
      att.answers.some(
        (ans: any) =>
          (typeof ans === 'number' && ans >= 0) ||
          (Array.isArray(ans) && ans.length > 0) ||
          (typeof ans === 'string' && ans.trim().length > 0)
      );

    const addUnsubmitted =
      hasFreshUnsubmittedRun ||
      (submitted === 0 && (att?.status === 'in-progress' || hasAnyAnswers));
    return submitted + (addUnsubmitted ? 1 : 0);
  }

  reachedLimit(att: QuizAttempt | null | undefined, a: any): boolean {
    const max = a?.maxAttempts ?? 0;
    if (!max || max <= 0) return false;
    return this.usedAttempts(att) >= max;
  }

  private openAttemptLimit(att: any, a: any) {
    this.attemptLimit = {
      used: this.usedAttempts(att),
      max: a?.maxAttempts ?? 0,
    };
    this.attemptLimitOpen = true;
  }

  onPickReadingFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0] || null;
    this.reading.file = f;
    if (f) this.reading.linkUrl = '';
  }

  private detectLessonType(
    file?: File,
    link?: string
  ): 'pdf' | 'image' | 'file' | 'link' {
    if (file) {
      const ct = (file.type || '').toLowerCase();
      if (ct.includes('pdf')) return 'pdf';
      if (ct.startsWith('image/')) return 'image';
      return 'file';
    }
    if (link) return 'link';
    return 'file';
  }

  async createReading() {
    this.readingError = '';
    if (!this.reading.title.trim()) {
      this.readingError = 'Titre requis.';
      return;
    }
    if (!this.reading.file && !this.reading.linkUrl.trim()) {
      this.readingError = 'Fichier ou lien requis.';
      return;
    }

    this.readingBusy = true;
    try {
      const cl = await firstValueFrom(this.class$);
      const me = await firstValueFrom(this.me$);
      if (!cl?.id || !me?.uid) throw new Error('Contexte invalide');

      const id = this.afs.createId();
      const now = new Date();
      const t = this.detectLessonType(
        this.reading.file || undefined,
        this.reading.linkUrl || undefined
      );

      let storagePath: string | undefined;
      let url: string | undefined;
      let contentType: string | undefined;
      let sizeBytes: number | undefined;

      if (this.reading.file) {
        const file = this.reading.file;
        const ext = file.name.split('.').pop() || 'dat';
        storagePath = `classes/${cl.id}/lessons/${id}.${ext}`;
        await this.storage.upload(storagePath, file);
        url = await firstValueFrom(
          this.storage.ref(storagePath).getDownloadURL()
        );
        contentType = file.type || undefined;
        sizeBytes = file.size;
      } else {
        url = this.reading.linkUrl.trim();
      }

      const doc: Lesson = {
        id,
        classId: cl.id, // ✅ class-scoped
        courseId: cl.courseId, // optional convenience
        title: this.reading.title.trim(),
        order: -now.getTime(), // keeps “latest first” if you ever sort asc
        type: t,
        storagePath,
        url,
        contentType,
        sizeBytes,
        createdAt: now,
        updatedAt: now,
        uploadedBy: me.uid,
        isPreview: false,
      };

      await this.afs.doc(`classes/${cl.id}/lessons/${id}`).set(doc);

      // reset + close
      this.reading = { title: '', linkUrl: '', file: null };
      this.addReadingOpen = false;
    } catch (e: any) {
      this.readingError = e?.message || 'Échec de la création.';
    } finally {
      this.readingBusy = false;
    }
  }

  async deleteReading(l: Lesson) {
    const ok = confirm(`Supprimer la lecture “${l.title}” ?`);
    if (!ok) return;
    const clId = await firstValueFrom(this.classId$);
    if (!clId || !l?.id) return;

    await this.afs.doc(`classes/${clId}/lessons/${l.id}`).delete();
    if (l.storagePath) {
      try {
        await this.storage.ref(l.storagePath).delete().toPromise();
      } catch {}
    }
  }

  // Add inside ClassComponent
  avatar(m: any): string | null {
    // Prefer common fields if your user model provides them
    return m?.user?.photoUrl || m?.user?.photoURL || m?.user?.avatarUrl || null;
  }

  displayName(m: any): string {
    const u = m?.user;
    const full = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
    return full || u?.name || u?.email || m?.uid || '—';
  }

  /** Load an existing question back into the draft editor */
  private loadDraftFromQuestion(q: QuizQuestion & { imageUrl?: string }) {
    this.draft = this.newDraft();
    this.draft.prompt = q.prompt ?? '';
    this.draft.imageUrl = (q as any).imageUrl ?? '';
    this.draft.imageFile = null;
    this.draft.imagePreviewUrl = undefined;

    if ((q as any).kind === 'text') {
      this.draft.kind = 'text';
      this.draft.correctText = (q as any).correctText ?? '';
      return;
    }

    const choices =
      Array.isArray((q as any).choices) && (q as any).choices.length
        ? (q as any).choices
        : ['', ''];

    if ((q as any).kind === 'mcq-multi') {
      this.draft.kind = 'mcq-multi';
      this.draft.choices = [...choices];
      this.draft.correctMulti = new Set<number>(
        Array.isArray((q as any).correctMulti) ? (q as any).correctMulti : []
      );
      this.draft.correctSingle = null;
      return;
    }

    // mcq-single
    this.draft.kind = 'mcq-single';
    this.draft.choices = [...choices];
    const corr =
      typeof (q as any).correct === 'number'
        ? (q as any).correct
        : typeof (q as any).correctIndex === 'number'
        ? (q as any).correctIndex
        : null;
    this.draft.correctSingle = corr;
    this.draft.correctMulti = new Set<number>();
  }

  /** Start editing an existing question (open the modal if closed) */
  editBuilderQuestion(qid: string) {
    const q = this.builderQuestions.find((x) => x.id === qid);
    if (!q) return;
    this.builderEditingId = qid;
    this.loadDraftFromQuestion(q as any);
    this.builderOpen = true;

    // Optional: scroll modal back to top for convenience
    setTimeout(() => {
      const el = document.querySelector(
        '[role="dialog"] .p-4, [role="dialog"] .p-5'
      ) as HTMLElement;
      el?.scrollTo?.({ top: 0, behavior: 'smooth' });
    }, 0);
  }

  /** Cancel current edit, keep the list unchanged */
  cancelEditDraft() {
    // cleanup preview blob if any
    if (this.draft.imagePreviewUrl)
      URL.revokeObjectURL(this.draft.imagePreviewUrl);
    this.builderEditingId = null;
    this.draft = this.newDraft();
  }

  private buildQuestionFromDraft(
    targetId: string
  ): EditorQuestion & { __file?: File } {
    const prompt = (this.draft.prompt || '').trim();
    if (!prompt) throw new Error('Écrivez l’énoncé.');

    if (this.draft.kind === 'text') {
      const ct = (this.draft.correctText || '').trim();
      if (!ct) throw new Error('Réponse exacte requise.');
      return {
        id: targetId,
        kind: 'text' as NonNullable<QuizQuestion['kind']>,
        prompt,
        correctText: ct,
        ...(this.draft.imageUrl?.trim()
          ? { imageUrl: this.draft.imageUrl.trim() }
          : {}),
        ...(this.draft.imageFile ? { __file: this.draft.imageFile } : {}),
      };
    }

    const cleaned = (this.draft.choices || [])
      .map((c) => c.trim())
      .filter((c) => c.length);

    if (cleaned.length < 2) throw new Error('Ajoutez au moins 2 choix.');

    if (this.draft.kind === 'mcq-single') {
      const idx = this.draft.correctSingle;
      if (idx == null || idx < 0 || idx >= cleaned.length) {
        throw new Error('Sélectionnez la bonne réponse.');
      }
      return {
        id: targetId,
        kind: 'mcq-single' as NonNullable<QuizQuestion['kind']>,
        prompt,
        choices: cleaned,
        correct: idx,
        correctIndex: idx, // keep mirror for compatibility
        ...(this.draft.imageUrl?.trim()
          ? { imageUrl: this.draft.imageUrl.trim() }
          : {}),
        ...(this.draft.imageFile ? { __file: this.draft.imageFile } : {}),
      };
    }

    // mcq-multi
    const corr = Array.from(this.draft.correctMulti.values())
      .filter((i) => i >= 0 && i < cleaned.length)
      .sort((a, b) => a - b);
    if (!corr.length)
      throw new Error('Sélectionnez au moins une bonne réponse.');

    return {
      id: targetId,
      kind: 'mcq-multi' as NonNullable<QuizQuestion['kind']>,
      prompt,
      choices: cleaned,
      correctMulti: corr,
      ...(this.draft.imageUrl?.trim()
        ? { imageUrl: this.draft.imageUrl.trim() }
        : {}),
      ...(this.draft.imageFile ? { __file: this.draft.imageFile } : {}),
    };
  }

  /** Existing: add-as-new (keep your current body, but simplified to reuse builder) */
  pushDraftToQuiz() {
    try {
      const id = crypto?.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
      const q = this.buildQuestionFromDraft(id);
      this.builderQuestions.push(q);

      // cleanup & reset
      if (this.draft.imagePreviewUrl)
        URL.revokeObjectURL(this.draft.imagePreviewUrl);
      this.draft = this.newDraft();
    } catch (e: any) {
      alert(e?.message || 'Impossible d’ajouter la question.');
    }
  }

  /** NEW: apply edits to the existing question (replace in-place, keep same id) */
  applyEditToQuiz() {
    if (!this.builderEditingId) return;
    try {
      const id = this.builderEditingId;
      const q = this.buildQuestionFromDraft(id);

      const idx = this.builderQuestions.findIndex((x) => x.id === id);
      if (idx >= 0) {
        this.builderQuestions[idx] = q;
      }

      // cleanup & exit edit mode
      if (this.draft.imagePreviewUrl)
        URL.revokeObjectURL(this.draft.imagePreviewUrl);
      this.draft = this.newDraft();
      this.builderEditingId = null;
    } catch (e: any) {
      alert(e?.message || 'Impossible de mettre à jour la question.');
    }
  }

  async beginEditQuiz(classId: string, assignmentId: string) {
    try {
      const a: any = await this.asgn.getCustomQuizForEdit(
        classId,
        assignmentId
      );
      if (!a) throw new Error('Quiz introuvable.');

      // Top-level fields (same as you had)
      this.builderTitle = a.title || '';
      this.builderPoints = (a.points ?? null) as number | null;

      this.builderTimed = !!a.timed;
      this.builderTimeMin = this.builderTimed
        ? Math.max(1, Math.round((a.timeLimitSec || 0) / 60))
        : null;

      const maxAttempts =
        typeof a.maxAttempts === 'number' ? a.maxAttempts : null;
      this.builderMaxAttempts =
        maxAttempts && maxAttempts < 10000 ? maxAttempts : null;

      this.builderAudience = (a.audience as 'all' | 'subset') || 'all';
      this.builderAssignees.clear();
      (Array.isArray(a.assignedTo) ? a.assignedTo : []).forEach((uid: string) =>
        this.builderAssignees.add(uid)
      );

      // 💡 Pull questions with robust fallbacks (pool → questions → subcollection)
      let rawQs: any[] = [];
      if (Array.isArray(a.pool) && a.pool.length) {
        rawQs = a.pool; // ✅ primary
      } else if (Array.isArray(a.questions) && a.questions.length) {
        rawQs = a.questions; // legacy inline field
      } else {
        rawQs = await this.asgn.getCustomQuizQuestions(classId, assignmentId); // subcollection
      }

      // Normalize to builder shape
      this.builderQuestions = rawQs.map((q, i) =>
        this.normalizeForBuilder(q, i)
      );

      // Open modal
      this.draft = this.newDraft();
      this.builderEditingId = null;
      this.editingQuizId = assignmentId;
      this.builderOpen = true;

      setTimeout(() => {
        document
          .querySelector('[role="dialog"]')
          ?.scrollTo?.({ top: 0, behavior: 'smooth' });
      }, 0);
    } catch (e: any) {
      alert(e?.message || 'Impossible de charger le quiz à éditer.');
    }
  }
  private builderHasData(): boolean {
    return (
      !!this.builderTitle.trim() ||
      this.builderQuestions.length > 0 ||
      this.builderPoints != null ||
      this.builderTimed ||
      this.builderTimeMin != null ||
      this.builderMaxAttempts != null ||
      this.builderAudience !== 'all' ||
      this.builderAssignees.size > 0
    );
  }

  async forkFromQuiz(classId: string, assignmentId: string) {
    if (!assignmentId) return;
    if (this.builderHasData()) {
      const ok = confirm(
        'Remplacer le contenu en cours par un quiz existant ? Les modifications non enregistrées seront perdues.'
      );
      if (!ok) return;
    }

    this.forkBusy = true;
    this.forkError = '';
    try {
      const a: any = await this.asgn.getCustomQuizForEdit(
        classId,
        assignmentId
      );
      if (!a) throw new Error('Quiz introuvable.');

      this.builderTitle = a.title ? `Copie de ${a.title}` : '';
      this.builderPoints = (a.points ?? null) as number | null;

      this.builderTimed = !!a.timed;
      this.builderTimeMin = this.builderTimed
        ? Math.max(1, Math.round((a.timeLimitSec || 0) / 60))
        : null;

      const maxAttempts =
        typeof a.maxAttempts === 'number' ? a.maxAttempts : null;
      this.builderMaxAttempts =
        maxAttempts && maxAttempts < 10000 ? maxAttempts : null;

      this.builderAudience = (a.audience as 'all' | 'subset') || 'all';
      this.builderAssignees.clear();
      (Array.isArray(a.assignedTo) ? a.assignedTo : []).forEach((uid: string) =>
        this.builderAssignees.add(uid)
      );

      let rawQs: any[] = [];
      if (Array.isArray(a.pool) && a.pool.length) {
        rawQs = a.pool;
      } else if (Array.isArray(a.questions) && a.questions.length) {
        rawQs = a.questions;
      } else {
        rawQs = await this.asgn.getCustomQuizQuestions(classId, assignmentId);
      }
      this.builderQuestions = rawQs.map((q, i) =>
        this.normalizeForBuilder(q, i)
      );

      this.builderEditingId = null;
      this.editingQuizId = null;
      this.forkSourceId = null;
      if (this.draft.imagePreviewUrl)
        URL.revokeObjectURL(this.draft.imagePreviewUrl);
      this.draft = this.newDraft();

      this.builderOpen = true;
      setTimeout(() => {
        document
          .querySelector('[role="dialog"]')
          ?.scrollTo?.({ top: 0, behavior: 'smooth' });
      }, 0);
    } catch (e: any) {
      this.forkError = e?.message || 'Impossible de charger ce quiz.';
    } finally {
      this.forkBusy = false;
    }
  }

  private normalizeForBuilder(raw: any, idx: number): EditorQuestion {
    const id = raw?.id ?? raw?.qid ?? `q${idx + 1}`;
    const prompt = raw?.prompt ?? '';
    const imageUrl = raw?.imageUrl ?? '';

    const hasChoices = Array.isArray(raw?.choices) && raw.choices.length > 0;
    const isMulti = Array.isArray(raw?.correctMulti);

    // Cast kind to whatever your QuizQuestion['kind'] union is
    const kind = (raw?.kind ??
      (hasChoices
        ? isMulti
          ? 'mcq-multi'
          : 'mcq-single'
        : 'text')) as NonNullable<QuizQuestion['kind']>;

    if (kind === 'text') {
      return {
        id,
        kind,
        prompt,
        imageUrl,
        correctText: raw?.correctText ?? '',
      };
    }

    if (kind === 'mcq-multi') {
      return {
        id,
        kind,
        prompt,
        imageUrl,
        choices: [...(raw.choices || [])],
        correctMulti: Array.isArray(raw.correctMulti) ? raw.correctMulti : [],
      };
    }

    // mcq-single
    const correct =
      typeof raw?.correct === 'number'
        ? raw.correct
        : typeof raw?.correctIndex === 'number'
        ? raw.correctIndex
        : null;

    return {
      id,
      kind,
      prompt,
      imageUrl,
      choices: [...(raw.choices || [])],
      // keep both for compatibility; editor uses `correct`
      ...(typeof correct === 'number'
        ? { correct, correctIndex: correct }
        : {}),
    } as EditorQuestion;
  }

  async updateCustomQuiz(classId: string) {
    if (!this.editingQuizId) return;

    // Validate like create()
    if (!this.builderTitle.trim()) {
      alert('Titre du quiz requis');
      return;
    }
    if (!this.builderQuestions.length) {
      alert('Ajoutez des questions');
      return;
    }

    const aid = this.editingQuizId;

    // Compute options
    let timeLimitSec: number | undefined;
    if (this.builderTimed) {
      const m = Math.max(1, Math.floor(this.builderTimeMin ?? 0));
      if (!m) {
        alert('Durée invalide');
        return;
      }
      timeLimitSec = m * 60;
    }

    const audience = this.builderAudience;
    const assignedTo =
      audience === 'subset' ? Array.from(this.builderAssignees) : [];
    const maxAttemptsNum = Number(this.builderMaxAttempts);
    const maxAttempts =
      Number.isFinite(maxAttemptsNum) && maxAttemptsNum > 0
        ? Math.floor(maxAttemptsNum)
        : 10000;

    // Prepare questions and upload any new files chosen during edits
    const updatedQuestions: any[] = [];
    for (const q of this.builderQuestions) {
      const qq: any = { ...q };
      if (qq.__file) {
        // store new image under the existing assignment id (tidy path)
        const url = await this.uploadQuestionImage(
          classId,
          aid,
          qq.id,
          qq.__file
        );
        qq.imageUrl = url;
        delete qq.__file;
      }
      updatedQuestions.push(qq);
    }

    // Persist
    try {
      if (this.asgn.updateCustomQuiz) {
        await this.asgn.updateCustomQuiz(
          classId,
          aid,
          this.builderTitle.trim(),
          updatedQuestions,
          this.builderPoints ?? undefined,
          {
            timed: this.builderTimed,
            timeLimitSec,
            audience,
            assignedTo,
            maxAttempts,
          }
        );
      } else {
        // Fallback: naive Firestore update (inline questions)
        await this.afs.doc(`classes/${classId}/assignments/${aid}`).update({
          title: this.builderTitle.trim(),
          points: this.builderPoints ?? null,
          numQuestions: updatedQuestions.length,
          timed: this.builderTimed,
          timeLimitSec: timeLimitSec ?? null,
          audience,
          assignedTo,
          maxAttempts,
          questions: updatedQuestions,
          updatedAt: new Date(),
        });
      }

      // Reset & close
      this.resetBuilder();
      this.editingQuizId = null;
      this.builderOpen = false;
    } catch (e: any) {
      alert(e?.message || 'Impossible de mettre à jour le quiz.');
    }
  }
  cancelQuizEdit() {
    this.editingQuizId = null;
    this.resetBuilder();
    this.builderOpen = false;
  }
  private resetBuilder() {
    this.builderTitle = '';
    this.builderPoints = null;
    this.builderQuestions = [];
    this.builderTimed = false;
    this.builderTimeMin = null;
    this.builderMaxAttempts = null;
    this.builderAudience = 'all';
    this.builderAssignees.clear();
    this.assigneeQuery = '';
    this.assigneeQuery$.next('');
    this.builderEditingId = null;
    this.forkSourceId = null;
    this.forkError = '';
    this.forkBusy = false;
    if (this.draft.imagePreviewUrl)
      URL.revokeObjectURL(this.draft.imagePreviewUrl);
    this.draft = this.newDraft();
  }
}
interface ClassMessageWithMeta extends ClassMessage {
  createdAtDate: Date;
}
