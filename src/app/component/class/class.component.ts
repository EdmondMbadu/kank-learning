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
  QuizAttempt,
  QuizQuestion,
} from 'src/app/model/user';
import { CourseService } from 'src/app/shared/course.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { MessageService } from 'src/app/shared/message.service';
import { AngularFireStorage } from '@angular/fire/compat/storage';
import { DataService } from 'src/app/shared/data.service';
// 1) Add these types + helpers at the top of the class (after existing fields)
type AvgStats = {
  pct: number | null;
  gradedCount: number; // number of graded items considered
  assignmentsCount?: number; // total assignments (for "your" average)
  attemptsCount?: number; // total attempts (for class average)
  totalCorrect: number;
  totalQuestions: number;
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
  builderQuestions: QuizQuestion[] = [];

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
    public data: DataService
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

  async removeMember(classId: string, uid: string) {
    this.removing[uid] = true;
    try {
      await this.classes.removeMember(classId, uid);
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

  pushDraftToQuiz() {
    const id = crypto?.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
    const prompt = this.draft.prompt.trim();
    if (!prompt) {
      alert('Écrivez l’énoncé.');
      return;
    }

    let q: QuizQuestion | null = null;

    if (this.draft.kind === 'text') {
      if (!this.draft.correctText.trim()) {
        alert('Réponse exacte requise.');
        return;
      }
      q = {
        id,
        kind: 'text',
        prompt,
        correctText: this.draft.correctText.trim(),
      };
    } else {
      const cleaned = (this.draft.choices || [])
        .map((c) => c.trim())
        .filter((c) => c.length);
      if (cleaned.length < 2) {
        alert('Ajoutez au moins 2 choix.');
        return;
      }

      if (this.draft.kind === 'mcq-single') {
        if (
          this.draft.correctSingle == null ||
          this.draft.correctSingle < 0 ||
          this.draft.correctSingle >= cleaned.length
        ) {
          alert('Sélectionnez la bonne réponse.');
          return;
        }
        q = {
          id,
          kind: 'mcq-single',
          prompt,
          choices: cleaned,
          correct: this.draft.correctSingle,
        };
      } else {
        // mcq-multi
        const corr = Array.from(this.draft.correctMulti.values())
          .filter((i) => i >= 0 && i < cleaned.length)
          .sort((a, b) => a - b);
        if (!corr.length) {
          alert('Sélectionnez au moins une bonne réponse.');
          return;
        }
        q = {
          id,
          kind: 'mcq-multi',
          prompt,
          choices: cleaned,
          correctMulti: corr,
        };
      }
    }
    if (this.draft.imageUrl?.trim()) {
      (q as any).imageUrl = this.draft.imageUrl.trim(); // already-hosted URL case
    }
    if (this.draft.imageFile) {
      (q as any).__file = this.draft.imageFile; // temp field for upload
    }

    this.builderQuestions.push(q!);

    // cleanup preview blob
    if (this.draft.imagePreviewUrl)
      URL.revokeObjectURL(this.draft.imagePreviewUrl);
    this.draft = this.newDraft();
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
        maxAttempts:
          (this.builderMaxAttempts ?? 0) > 0
            ? this.builderMaxAttempts!
            : undefined,
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
}
interface ClassMessageWithMeta extends ClassMessage {
  createdAtDate: Date;
}
