import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest, of, Subscription, timer } from 'rxjs';
import { map, switchMap, shareReplay, take } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { ClassService } from 'src/app/shared/class.service';
import { QuizAssignment, QuizAttempt, QuizQuestion } from 'src/app/model/user';

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

  instructorAttempts$ = combineLatest([
    this.isTeacher$,
    this.classId$,
    this.quizId$,
  ]).pipe(
    switchMap(([ok, cid, qid]) =>
      ok ? this.asgn.attemptsForAssignment$(cid, qid) : of([])
    ),
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
  confirmStartOpen = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private auth: AuthService,
    private asgn: AssignmentService,
    private classes: ClassService
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
    const forceNew = att?.status === 'submitted' || att?.status === 'expired';

    if (!a.timed) {
      this.startAttempt(forceNew);
      return;
    }

    // for timed: show confirm; remember the intent to retake
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
      this.me$.pipe(take(1)).toPromise(),
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
}
