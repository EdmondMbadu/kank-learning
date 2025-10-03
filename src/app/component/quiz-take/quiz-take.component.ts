import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest, firstValueFrom, of, Subscription, timer } from 'rxjs';
import { map, switchMap, shareReplay, take } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { ClassService } from 'src/app/shared/class.service';
import { QuizAssignment, QuizAttempt } from 'src/app/model/user';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import jsPDF from 'jspdf';

// Type helper (optional)
type AttemptRow = QuizAttempt & { uid: string; name?: string };
// ---- VM type for the table
type ScoreboardRow = {
  uid: string;
  name: string; // "First Last" | displayName | uid
  email: string; // fallback: ''
  attemptCount: number; // total retakes
  status: 'in-progress' | 'submitted' | 'expired' | null;
  answered: number; // answered count
  total: number; // a.numQuestions
  score: number | null; // raw score
  percent: number | null; // 0..100, null if not graded
  lastSubmittedAt: Date | null;
};
type VerdictItem = {
  index: number;
  qid: string | null;
  prompt: string;
  kind: 'mcq-single' | 'mcq-multi' | 'text' | string;
  user: number | number[] | string | null;
  userLabels?: string[]; // for single/multi
  userText?: string; // for text
  correctLabels?: string[]; // for single/multi
  correctText?: string[]; // for text
  isCorrect: boolean;
  // correct: number[] | string[] | number | string | null;
};

@Component({
  selector: 'app-quiz-take',
  templateUrl: './quiz-take.component.html',
})
export class QuizTakeComponent implements OnInit, OnDestroy {
  detailsOpen: Record<string, boolean> = {};
  detailsVerdicts: Record<string, VerdictItem[]> = {};
  classId$ = this.route.paramMap.pipe(map((p) => p.get('classId')!));
  quizId$ = this.route.paramMap.pipe(map((p) => p.get('quizId')!));
  me$ = this.auth.effectiveUser$;

  showResult = false;
  resultScore = 0;
  resultTotal = 0;
  resultPct = 0;
  resultStatus: 'submitted' | 'expired' = 'submitted';

  // modals
  confirmStartOpen = false;
  maxAttemptsModalOpen = false;

  // for cap modal message
  lastUsedForModal = 0;
  lastMaxForModal = 0;

  private _forceNewOnConfirm = false;

  // data
  assignment$ = combineLatest([this.classId$, this.quizId$]).pipe(
    switchMap(([cid, qid]) => this.asgn.assignment$(cid, qid)),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  myAttempt$ = combineLatest([this.classId$, this.quizId$, this.me$]).pipe(
    switchMap(([cid, qid, me]) =>
      me?.uid ? this.asgn.attempt$(cid, qid, me.uid) : of(null)
    ),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // role (for scoreboard)
  isTeacher$ = combineLatest([this.classId$, this.me$]).pipe(
    switchMap(([cid, me]) => this.classes.memberRole$(cid, me?.uid)),
    map((r) => r === 'instructor' || r === 'ta'),
    shareReplay({ bufferSize: 1, refCount: true })
  );
  // ---- use the "all" attempts feed so we keep attemptCount/history too
  instructorAttempts$ = combineLatest([
    this.isTeacher$,
    this.classId$,
    this.quizId$,
  ]).pipe(
    switchMap(([ok, cid, qid]) =>
      ok ? this.asgn.attemptsForAssignmentAll$(cid, qid) : of([])
    ),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // ---- join attempts with user profiles and compute fields for the grid
  scoreboardRows$ = combineLatest([
    this.instructorAttempts$,
    this.assignment$,
  ]).pipe(
    switchMap(([rows, a]) => {
      const total = a?.numQuestions ?? 0;
      const uids = Array.from(new Set(rows.map((r) => r.uid))).filter(Boolean);
      if (!uids.length) {
        return of([] as ScoreboardRow[]);
      }

      // load users/{uid} docs (adjust path/fields if yours differ)
      const streams = uids.map((uid) =>
        this.afs
          .doc<any>(`users/${uid}`)
          .valueChanges()
          .pipe(
            map((u) => ({
              uid,
              first: u?.firstName ?? u?.firstname ?? u?.first_name ?? '',
              last: u?.lastName ?? u?.lastname ?? u?.last_name ?? '',
              displayName: u?.displayName ?? u?.name ?? '',
              email: u?.email ?? '',
            }))
          )
      );

      return combineLatest(streams).pipe(
        map((profiles) => {
          const byId = new Map(profiles.map((p) => [p.uid, p]));

          const toScoreboard = (r: any): ScoreboardRow => {
            const p = byId.get(r.uid);
            const name = p
              ? p.first || p.last
                ? `${p.first} ${p.last}`.trim()
                : p.displayName || r.uid
              : r.uid;

            const answers = Array.isArray(r.answers) ? r.answers : [];
            const answered = answers.filter((x: any) => {
              if (typeof x === 'number') return x >= 0; // mcq-single
              if (Array.isArray(x)) return x.length > 0; // mcq-multi
              if (typeof x === 'string') return x.trim().length > 0; // text
              return false;
            }).length;

            const score: number | null = Number.isFinite(r.score)
              ? Number(r.score)
              : null;
            const percent: number | null =
              score === null || !total
                ? null
                : Math.round((score / total) * 100);

            const status = (r.status ?? null) as ScoreboardRow['status'];
            const lastFromHist =
              Array.isArray(r.history) && r.history.length
                ? r.history
                    .map((h: any) => this.tsToDate(h?.submittedAt))
                    .filter((d: Date | null): d is Date => !!d)
                    .sort((a: any, b: any) => b.getTime() - a.getTime())[0] ||
                  null
                : null;

            const lastRoot =
              this.tsToDate(r?.submittedAt) || this.tsToDate(r?.gradedAt);

            const lastSubmittedAt = lastFromHist || lastRoot;

            return {
              uid: r.uid,
              name,
              email: p?.email ?? '',
              attemptCount: r?.attemptCount ?? 0,
              status,
              answered,
              total,
              score,
              percent,
              lastSubmittedAt,
            };
          };

          // build and sort: graded first (by % desc), then in-progress (by answered desc), then the rest by name
          const vms = (rows as any[]).map(toScoreboard);
          const rank = (s: ScoreboardRow['status'], scored: boolean) => {
            // lower rank = earlier in the list
            if (scored) return 0; // submitted/expired with score
            if (s === 'in-progress') return 1;
            return 2;
          };
          vms.sort((a, b) => {
            const ra = rank(a.status, a.score !== null);
            const rb = rank(b.status, b.score !== null);
            if (ra !== rb) return ra - rb;

            // if both scored, sort by percent desc, then lastSubmittedAt desc
            if (a.score !== null && b.score !== null) {
              if (b.percent! !== a.percent!) return b.percent! - a.percent!;
              const ta = a.lastSubmittedAt?.getTime() ?? 0;
              const tb = b.lastSubmittedAt?.getTime() ?? 0;
              return tb - ta;
            }

            // if both in-progress, sort by answered desc
            if (a.status === 'in-progress' && b.status === 'in-progress') {
              if (b.answered !== a.answered) return b.answered - a.answered;
            }

            // fallback: alphabetical by name
            return a.name.localeCompare(b.name);
          });

          return vms;
        })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // timer + lock
  timeLeft$ = combineLatest([this.assignment$, this.myAttempt$]).pipe(
    switchMap(([a, att]) => {
      if (!a?.timed) return of(null);
      const expires = (att as any)?.expiresAt?.toDate?.() as Date | undefined;
      if (!expires) return of(null);
      return timer(0, 1000).pipe(
        map(() =>
          Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))
        )
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  lockTimed = false;
  private ticker?: Subscription;
  private lastAutosubmitted: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private auth: AuthService,
    private asgn: AssignmentService,
    private classes: ClassService,
    private afs: AngularFirestore
  ) {}

  ngOnInit(): void {
    // lock panel & auto-submit when timer hits 0
    this.ticker = combineLatest([
      this.timeLeft$,
      this.assignment$,
      this.myAttempt$,
      this.classId$,
      this.quizId$,
    ]).subscribe(async ([secs, a, att, cid, qid]) => {
      const active = !!a?.timed && att?.score == null && secs !== null;
      this.lockTimed = active && secs! > 0;
      if (active && secs === 0 && this.lastAutosubmitted !== qid) {
        this.lastAutosubmitted = qid!;
        try {
          await this.submit(cid);
        } catch {}
      }
    });

    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }

  ngOnDestroy(): void {
    this.ticker?.unsubscribe();
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
  }

  private beforeunloadShown = false;
  private beforeUnloadHandler = (e: BeforeUnloadEvent) => {
    if (this.lockTimed && !this.beforeunloadShown) {
      e.preventDefault();
      e.returnValue = '';
      this.beforeunloadShown = true;
    }
  };

  // ===== Attempt caps helpers =====
  getMaxAttempts(a: QuizAssignment | null | undefined): number | null {
    const m = (a as any)?.maxAttempts;
    return Number.isFinite(m) && m > 0 ? Number(m) : null;
  }
  hasCap(a: QuizAssignment | null | undefined): boolean {
    return this.getMaxAttempts(a) !== null;
  }
  computeUsedAttempts(
    a: QuizAssignment | null | undefined,
    att: QuizAttempt | null | undefined
  ): number {
    // Uses per-user counter incremented on submit; falls back to history length
    return (att?.attemptCount ?? 0) | 0;
  }
  canRetake(a: QuizAssignment | null, att: QuizAttempt | null): boolean {
    const cap = this.getMaxAttempts(a);
    if (cap === null) return true; // unlimited
    const used = this.computeUsedAttempts(a, att);
    return used < cap;
  }

  // UI helpers
  clock(sec: number) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor((s % 3600) / 60),
      r = s % 60,
      h = Math.floor(s / 3600);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
      : `${m}:${r.toString().padStart(2, '0')}`;
  }
  getById<T extends { id: string }>(
    arr: T[] | null | undefined,
    id: string | null | undefined
  ): T | null {
    if (!arr || !id) return null;
    return arr.find((x) => x.id === id) ?? null;
  }
  answeredCount(att: QuizAttempt | null | undefined) {
    if (!att?.answers?.length) return 0;
    return att.answers.filter((n) => n != null && n >= 0).length;
  }

  async confirmStart() {
    this.confirmStartOpen = false;
    await this.startAttempt(this._forceNewOnConfirm);
    this._forceNewOnConfirm = false;
  }

  // accept optional flag
  async startAttempt(forceNew = false) {
    const cid = await this.classId$.pipe(take(1)).toPromise();
    const qid = await this.quizId$.pipe(take(1)).toPromise();
    const me = await this.me$.pipe(take(1)).toPromise();
    if (!cid || !qid || !me?.uid) return;
    await this.asgn.startAttemptIfNeeded(cid, qid, me.uid, { forceNew });
  }

  onStartClick(a: QuizAssignment | null, att: QuizAttempt | null) {
    if (!a) return;

    // If a cap exists and it's reached, show info modal (button is still clickable)
    if (!this.canRetake(a, att)) {
      const used = this.computeUsedAttempts(a, att);
      const cap = this.getMaxAttempts(a)!;
      this.lastUsedForModal = used;
      this.lastMaxForModal = cap;
      this.maxAttemptsModalOpen = true;
      return;
    }

    // else: proceed (with confirm for timed)
    const forceNew = att?.status === 'submitted' || att?.status === 'expired';

    if (!a.timed) {
      this.startAttempt(forceNew);
      return;
    }

    this._forceNewOnConfirm = forceNew;
    this.confirmStartOpen = true;
  }

  async selectSingle(idx: number, choice: number) {
    const [cid, qid, me] = await Promise.all([
      this.classId$.pipe(take(1)).toPromise(),
      this.quizId$.pipe(take(1)).toPromise(),
      this.me$.pipe(take(1)).toPromise(),
    ]);
    if (!cid || !qid || !me?.uid) return;
    await this.asgn.saveAnswerSingle(cid, qid, me.uid, idx, choice);
  }

  async toggleMulti(idx: number, choice: number) {
    const [cid, qid, me] = await Promise.all([
      this.classId$.pipe(take(1)).toPromise(),
      this.quizId$.pipe(take(1)).toPromise(),
      this.me$.pipe(take(1)).toPromise(),
    ]);
    if (!cid || !qid || !me?.uid) return;
    await this.asgn.toggleAnswerMulti(cid, qid, me.uid, idx, choice);
  }

  async saveText(idx: number, text: string) {
    const [cid, qid, me] = await Promise.all([
      this.classId$.pipe(take(1)).toPromise(),
      this.quizId$.pipe(take(1)).toPromise(),
      this.me$.pipe(take(1)).toPromise(), // ← missing before
    ]);
    if (!cid || !qid || !me?.uid) return;
    await this.asgn.saveAnswerText(cid, qid, me.uid, idx, text);
  }

  async submit(classIdOverride?: string) {
    const cid =
      classIdOverride || (await this.classId$.pipe(take(1)).toPromise());
    const qid = await this.quizId$.pipe(take(1)).toPromise();
    const me = await this.me$.pipe(take(1)).toPromise();
    if (!cid || !qid || !me?.uid) return;

    const res = await this.asgn.submitAndGrade(cid, qid, me.uid);
    this.resultScore = res.score ?? 0;
    this.resultTotal = res.total ?? 0;
    this.resultStatus = res.status;
    this.resultPct = this.resultTotal
      ? Math.round((this.resultScore / this.resultTotal) * 100)
      : 0;

    this.showResult = true; // open the modal
  }

  async closeResult() {
    this.showResult = false;
    const cid = await this.classId$.pipe(take(1)).toPromise();
    if (cid) this.router.navigate(['/class', cid]);
  }

  // quiz-take.component.ts
  isMultiChecked(
    att: QuizAttempt | null | undefined,
    i: number,
    j: number
  ): boolean {
    const a = att?.answers?.[i];
    return Array.isArray(a) && a.includes(j);
  }

  isSingleSelected(
    att: QuizAttempt | null | undefined,
    i: number,
    j: number
  ): boolean {
    const v = att?.answers?.[i];
    return typeof v === 'number' && v === j;
  }

  textAnswer(att: QuizAttempt | null | undefined, i: number): string {
    const v = att?.answers?.[i];
    return typeof v === 'string' ? v : '';
  }
  // scoreboardRows$ = this.instructorAttempts$.pipe(
  //   switchMap((rows: AttemptRow[]) => {
  //     const uids = Array.from(new Set(rows.map((r) => r.uid).filter(Boolean)));
  //     if (!uids.length) return of(rows);

  //     // load each user doc: users/{uid}
  //     const streams = uids.map((uid) =>
  //       this.afs
  //         .doc<any>(`users/${uid}`)
  //         .valueChanges()
  //         .pipe(
  //           map((u) => ({
  //             uid,
  //             firstName: u?.firstName ?? u?.firstname ?? u?.first_name ?? '',
  //             lastName: u?.lastName ?? u?.lastname ?? u?.last_name ?? '',
  //             displayName: u?.displayName ?? u?.name ?? '',
  //           }))
  //         )
  //     );

  //     return combineLatest(streams).pipe(
  //       map((profiles) => {
  //         const byId = new Map(profiles.map((p) => [p.uid, p]));
  //         return rows.map((r) => {
  //           const p = byId.get(r.uid);
  //           const name = p
  //             ? p.firstName || p.lastName
  //               ? `${p.firstName} ${p.lastName}`.trim()
  //               : p.displayName || r.uid
  //             : r.uid;
  //           return { ...r, name };
  //         });
  //       })
  //     );
  //   }),
  //   shareReplay({ bufferSize: 1, refCount: true })
  // );

  private tsToDate(x: any): Date | null {
    if (!x) return null;
    // Firestore Timestamp (compat) exposes .toDate()
    if (typeof x.toDate === 'function') {
      try {
        return x.toDate();
      } catch {
        /* noop */
      }
    }
    return x instanceof Date ? x : null;
  }

  // (optional) trackBy for *ngFor
  trackByUid(_i: number, r: ScoreboardRow) {
    return r.uid;
  }

  private getCorrectKey(q: any) {
    // normalize various schema flavors for "correct answer(s)"
    // single choice → number
    if (Number.isFinite(q?.answerIndex))
      return { kind: 'single', value: q.answerIndex as number };
    if (Number.isFinite(q?.correctIndex))
      return { kind: 'single', value: q.correctIndex as number };
    if (Number.isFinite(q?.answer))
      return { kind: 'single', value: Number(q.answer) };

    // multi choice → number[]
    if (Array.isArray(q?.correctIndices))
      return { kind: 'multi', value: q.correctIndices as number[] };
    if (Array.isArray(q?.answers) && q?.kind === 'mcq-multi')
      return { kind: 'multi', value: q.answers as number[] };
    if (Array.isArray(q?.answer) && q?.kind === 'mcq-multi')
      return { kind: 'multi', value: q.answer as number[] };

    // text → string[]
    if (Array.isArray(q?.acceptedAnswers))
      return { kind: 'text', value: q.acceptedAnswers as string[] };
    if (Array.isArray(q?.answers) && q?.kind === 'text')
      return { kind: 'text', value: q.answers as string[] };
    if (typeof q?.answer === 'string' && q?.kind === 'text')
      return { kind: 'text', value: [q.answer as string] };

    return { kind: 'unknown', value: null };
  }

  private eqArray(a?: number[] | string[], b?: number[] | string[]) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const A = [...a].sort();
    const B = [...b].sort();
    return A.every((v, i) => String(v) === String(B[i]));
  }

  private normalizeText(s: any): string {
    return String(s ?? '')
      .trim()
      .toLowerCase();
  }

  private isTextCorrect(user: any, accepted: string[]) {
    const u = this.normalizeText(user);
    if (!u) return false;
    return accepted.map((x) => this.normalizeText(x)).some((x) => x === u);
  }

  private isSingleCorrect(user: any, correctIndex: number) {
    return Number.isFinite(user) && Number(user) === correctIndex;
  }
  private isMultiCorrect(user: any, correctIndices: number[]) {
    const arr = Array.isArray(user) ? (user as number[]) : [];
    return this.eqArray(arr, correctIndices);
  }

  private labelsForChoiceIndices(
    q: any,
    idxs: number[] | number | null
  ): string[] {
    if (!q?.choices) return [];
    const arr = Array.isArray(idxs)
      ? idxs
      : Number.isFinite(idxs)
      ? [Number(idxs)]
      : [];
    return arr
      .map((i) =>
        Number.isFinite(i) && q.choices[i] != null ? String(q.choices[i]) : ''
      )
      .filter(Boolean);
  }

  /** Build per-question verdicts for a given attempt */
  /** Build per-question verdicts for a given attempt */
  private buildVerdicts(a: any, att: any): VerdictItem[] {
    if (!a?.pool || !att?.selectedIds || !Array.isArray(att.answers)) return [];
    const byId = new Map((a.pool as any[]).map((q: any) => [q.id, q]));
    const selected: string[] = att.selectedIds as string[];

    const res: VerdictItem[] = [];
    for (let i = 0; i < selected.length; i++) {
      const qid = selected[i] ?? null;
      const q = qid ? byId.get(qid) : null;
      const user = att.answers[i] ?? null;

      const kind: VerdictItem['kind'] = q?.kind || 'unknown';
      const correct = this.getCorrectKey(q);

      let isCorrect = false;
      let userLabels: string[] | undefined;
      let correctLabels: string[] | undefined;
      let userText: string | undefined;
      let correctText: string[] | undefined;

      if (kind === 'mcq-single' && correct.kind === 'single') {
        isCorrect = this.isSingleCorrect(user, correct.value as number);
        userLabels = this.labelsForChoiceIndices(q, user);
        correctLabels = this.labelsForChoiceIndices(q, correct.value as number);
      } else if (kind === 'mcq-multi' && correct.kind === 'multi') {
        isCorrect = this.isMultiCorrect(user, correct.value as number[]);
        userLabels = this.labelsForChoiceIndices(
          q,
          Array.isArray(user) ? user : []
        );
        correctLabels = this.labelsForChoiceIndices(
          q,
          correct.value as number[]
        );
      } else if (kind === 'text' && correct.kind === 'text') {
        const acceptedStrings: string[] = this.toArray<any>(correct.value)
          .map((x) => String(x))
          .filter((s) => s.trim().length > 0);

        userText = String(user ?? '');
        correctText = acceptedStrings;
        isCorrect = this.isTextCorrect(userText, acceptedStrings);
      } else {
        // Best-effort fallback for schema mismatches
        if (Number.isFinite(user) && Number.isFinite(correct.value)) {
          isCorrect = Number(user) === Number(correct.value);
          userLabels = this.labelsForChoiceIndices(q, user);
          correctLabels = this.labelsForChoiceIndices(
            q,
            correct.value as number
          );
        } else if (Array.isArray(user) && Array.isArray(correct.value)) {
          isCorrect = this.eqArray(user as any[], correct.value as any[]);
          userLabels = this.labelsForChoiceIndices(q, user as number[]);
          correctLabels = this.labelsForChoiceIndices(
            q,
            correct.value as number[]
          );
        } else {
          const acceptedStrings: string[] = this.toArray<any>(correct.value)
            .map((x) => String(x))
            .filter((s) => s.trim().length > 0);

          userText = String(user ?? '');
          correctText = acceptedStrings;
          isCorrect = this.isTextCorrect(userText, acceptedStrings);
        }
      }

      res.push({
        index: i,
        qid,
        prompt: q?.prompt ?? '',
        kind,
        user,
        userLabels,
        userText,
        correctLabels,
        correctText,
        isCorrect,
      });
    }
    return res;
  }

  async toggleDetails(uid: string) {
    this.detailsOpen[uid] = !this.detailsOpen[uid];
    if (!this.detailsOpen[uid]) return;

    const [a, attempts] = await firstValueFrom(
      combineLatest([this.assignment$, this.instructorAttempts$])
    );

    const att = (attempts as any[]).find((x) => x?.uid === uid) || null;
    this.detailsVerdicts[uid] = this.buildVerdicts(a, att);
  }
  private toArray<T>(v: T | T[] | null | undefined): T[] {
    return v == null ? [] : Array.isArray(v) ? v : [v];
  }

  async downloadDetailsPdf(row: ScoreboardRow) {
    const [assignment, attempts] = await firstValueFrom(
      combineLatest([this.assignment$, this.instructorAttempts$])
    );

    const attempt = (attempts as AttemptRow[]).find((a) => a.uid === row.uid);
    if (!assignment || !attempt) {
      return;
    }

    const verdicts = this.buildVerdicts(assignment, attempt);
    this.detailsVerdicts[row.uid] = verdicts;

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const marginX = 48;
    const usableWidth = 515;
    let y = 64;

    doc.setFontSize(16);
    doc.text(`Quiz : ${assignment.title ?? 'Sans titre'}`, marginX, y);
    y += 22;

    doc.setFontSize(12);
    const metaLines: string[] = [];
    metaLines.push(`Étudiant : ${row.name}`);
    if (row.email) metaLines.push(`Courriel : ${row.email}`);
    const total = assignment?.numQuestions ?? row.total;
    const scoreLabel =
      attempt.score != null ? `${attempt.score}/${total}` : 'Non disponible';
    metaLines.push(`Score : ${scoreLabel}`);
    metaLines.push(`Statut : ${row.status ?? '—'}`);

    metaLines.forEach((line) => {
      doc.text(line, marginX, y);
      y += 16;
    });

    if (row.lastSubmittedAt) {
      doc.text(
        `Dernière remise : ${row.lastSubmittedAt.toLocaleString()}`,
        marginX,
        y
      );
      y += 16;
    }

    if (verdicts.length === 0) {
      doc.text('Aucune question à afficher.', marginX, y);
      doc.save(`${this.safeFileName(assignment.title ?? 'quiz')}-${row.uid}.pdf`);
      return;
    }

    y += 8;
    doc.setFontSize(14);
    doc.text('Détails des questions', marginX, y);
    y += 20;
    doc.setFontSize(11);

    verdicts.forEach((v) => {
      const prompt = v.prompt?.trim().length
        ? `${v.index + 1}. ${v.prompt}`
        : `${v.index + 1}. Question supprimée`;

      const promptLines = doc.splitTextToSize(prompt, usableWidth);
      y = this.ensurePageSpace(doc, y, promptLines.length * 14);
      doc.setFont('helvetica', 'bold');
      doc.text(promptLines, marginX, y);
      y += promptLines.length * 14;

      doc.setFont('helvetica', 'normal');
      const resultLine = `Résultat : ${v.isCorrect ? 'Bonne réponse' : 'Mauvaise réponse'}`;
      const userLine = `Réponse de l'étudiant : ${this.formatUserAnswer(v)}`;
      const expectedLine = `Réponse attendue : ${this.formatCorrectAnswer(v)}`;

      const blocks = [resultLine, userLine, expectedLine];
      blocks.forEach((line) => {
        const lines = doc.splitTextToSize(line, usableWidth);
        y = this.ensurePageSpace(doc, y, lines.length * 14);
        doc.text(lines, marginX, y);
        y += lines.length * 14;
      });

      y += 6;
    });

    const filename = `${this.safeFileName(assignment.title ?? 'quiz')}-${this.safeFileName(row.name || row.uid)}.pdf`;
    doc.save(filename);
  }

  private safeFileName(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      || 'export';
  }

  private ensurePageSpace(doc: jsPDF, currentY: number, needed: number): number {
    const limit = doc.internal.pageSize.getHeight() - 72;
    if (currentY + needed <= limit) {
      return currentY;
    }
    doc.addPage();
    return 64;
  }

  private formatUserAnswer(v: VerdictItem): string {
    if (v.kind === 'mcq-single' || v.kind === 'mcq-multi') {
      if (v.userLabels?.length) return v.userLabels.join(', ');
      if (Array.isArray(v.user)) return (v.user as any[]).join(', ');
      if (v.user != null) return String(v.user);
      return '—';
    }
    if (v.kind === 'text') {
      return v.userText?.trim().length ? v.userText : '—';
    }
    if (Array.isArray(v.userLabels) && v.userLabels.length) {
      return v.userLabels.join(', ');
    }
    return v.user != null && String(v.user).trim().length
      ? String(v.user)
      : '—';
  }

  private formatCorrectAnswer(v: VerdictItem): string {
    if (v.kind === 'mcq-single' || v.kind === 'mcq-multi') {
      if (v.correctLabels?.length) return v.correctLabels.join(', ');
      return '—';
    }
    if (v.kind === 'text') {
      if (v.correctText?.length) return v.correctText.join(', ');
      return '—';
    }
    if (v.correctLabels?.length) return v.correctLabels.join(', ');
    if (v.correctText?.length) return v.correctText.join(', ');
    return '—';
  }
}
