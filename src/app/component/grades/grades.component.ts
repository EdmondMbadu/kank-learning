// src/app/components/grades/grades.component.ts
import { Component } from '@angular/core';
import { Observable, of, combineLatest } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { ClassSection, QuizAttempt } from 'src/app/model/user';
import { DataService } from 'src/app/shared/data.service';

type ClassGradeCard = {
  cl: ClassSection;
  avgPct: number | null; // weighted average %
  gradedCount: number; // attempts with a score
  assignmentsCount: number; // total assignments in class
  totalCorrect: number; // sum of correct answers across graded attempts
  totalQuestions: number; // sum of total questions across those assignments
};

@Component({
  selector: 'app-grades',
  templateUrl: './grades.component.html',
  styleUrls: ['./grades.component.css'],
})
export class GradesComponent {
  me$ = this.auth.user$;

  /** Per-class cards with computed averages for the signed-in user */
  cards$: Observable<ClassGradeCard[]> = this.me$.pipe(
    switchMap((me) =>
      me?.uid
        ? this.classes.myClassesAsMember$(me.uid)
        : of([] as ClassSection[])
    ),
    switchMap((cls) => {
      if (!cls.length) return of([] as ClassGradeCard[]);

      // For each class → load assignments + my attempt for each assignment → reduce to one card
      const perClass$ = cls.map((cl) =>
        this.asgn.assignments$(cl.id!).pipe(
          switchMap((assigns) => {
            if (!assigns?.length) {
              return of({
                cl,
                avgPct: null,
                gradedCount: 0,
                assignmentsCount: 0,
                totalCorrect: 0,
                totalQuestions: 0,
              } as ClassGradeCard);
            }

            return combineLatest(
              assigns.map((a) =>
                this.asgn.attempt$(
                  cl.id!,
                  a.id!,
                  (this.auth.currentUser || null)?.uid || ''
                )
              )
            ).pipe(
              map((attempts: Array<QuizAttempt | null>) => {
                let totalCorrect = 0;
                let totalQuestions = 0;
                let gradedCount = 0;

                assigns.forEach((a, i) => {
                  const att = attempts[i];
                  // Prefer assignment.numQuestions, fallback to attempt.answers length
                  const qTotal =
                    (a as any)?.numQuestions ??
                    (Array.isArray(att?.answers) ? att!.answers.length : 0);

                  if (att?.score != null && qTotal > 0) {
                    totalCorrect += att.score;
                    totalQuestions += qTotal;
                    gradedCount++;
                  }
                });

                const avgPct =
                  totalQuestions > 0
                    ? Math.round((totalCorrect / totalQuestions) * 100)
                    : null;

                return {
                  cl,
                  avgPct,
                  gradedCount,
                  assignmentsCount: assigns.length,
                  totalCorrect,
                  totalQuestions,
                } as ClassGradeCard;
              })
            );
          })
        )
      );

      return combineLatest(perClass$).pipe(
        // Sort by best avg first; classes without grades at the end
        map((list) =>
          list.slice().sort((a, b) => (b.avgPct ?? -1) - (a.avgPct ?? -1))
        )
      );
    })
  );

  /** Global overview: total classes, classes with grades, overall weighted average. */
  overview$ = this.cards$.pipe(
    map((cards) => {
      const withData = cards.filter((c) => c.totalQuestions > 0);
      const totalClasses = cards.length;
      const gradedClasses = withData.length;
      const grandCorrect = withData.reduce((s, c) => s + c.totalCorrect, 0);
      const grandTotal = withData.reduce((s, c) => s + c.totalQuestions, 0);
      const overall =
        grandTotal > 0 ? Math.round((grandCorrect / grandTotal) * 100) : null;

      return { totalClasses, gradedClasses, overall };
    })
  );

  constructor(
    private auth: AuthService,
    private classes: ClassService,
    private asgn: AssignmentService,
    private data: DataService
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
  // ---- UI helpers ----
  conic(pct: number | null) {
    if (pct == null || isNaN(pct)) {
      // gray ring
      return `conic-gradient(rgb(226 232 240) 0% 100%)`;
    }
    // indigo→cyan sweep for the completed portion, slate for the remainder
    return `conic-gradient(
      rgb(79 70 229) 0% ${Math.max(0, Math.min(100, pct))}%,
      rgb(203 213 225) ${Math.max(0, Math.min(100, pct))}% 100%
    )`;
  }

  barWidth(pct: number | null) {
    const p = Math.max(0, Math.min(100, pct ?? 0));
    return `${p}%`;
  }

  trackByClassId(_: number, c: ClassGradeCard) {
    return c.cl.id;
  }
}
