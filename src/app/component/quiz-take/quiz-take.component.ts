import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest, of, Subscription, timer } from 'rxjs';
import { map, switchMap, shareReplay, take } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { ClassService } from 'src/app/shared/class.service';
import { QuizAssignment, QuizAttempt } from 'src/app/model/user';
import { AngularFirestore } from '@angular/fire/compat/firestore';

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
@Component({
  selector: 'app-quiz-take',
  templateUrl: './quiz-take.component.html',
})
export class QuizTakeComponent implements OnInit, OnDestroy {
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
}
