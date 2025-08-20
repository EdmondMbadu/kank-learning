import { Component } from '@angular/core';
import { combineLatest, of } from 'rxjs';
import { map, switchMap, shareReplay } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import { AssignmentService } from 'src/app/shared/assignment.service';
import { QuizAssignment, QuizAttempt } from 'src/app/model/user';

type AnyClass = { id: string; title?: string; name?: string };

interface Row {
  cl: AnyClass;
  asg: QuizAssignment & { id?: string };
  att: QuizAttempt | null;
}

@Component({
  selector: 'app-activity',
  templateUrl: './activity.component.html',
})
export class ActivityComponent {
  me$ = this.auth.effectiveUser$;

  // All classes for the user
  classes$ = this.me$.pipe(
    switchMap((me) => {
      if (!me?.uid) return of<AnyClass[]>([]);
      return combineLatest([
        this.classes.myClasses$(me.uid),
        this.classes.myClassesAsMember$(me.uid),
      ]).pipe(
        map(([a, b]) => {
          const m = new Map<string, AnyClass>();
          [...a, ...b].forEach((c) => c?.id && m.set(c.id, c));
          return Array.from(m.values());
        })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // All assignments across all classes -> flatten
  assignments$ = this.classes$.pipe(
    switchMap((cls) => {
      if (!cls.length)
        return of(
          [] as { cl: AnyClass; asg: QuizAssignment & { id?: string } }[]
        );
      return combineLatest(
        cls.map((cl) =>
          this.asgn
            .assignments$(cl.id)
            .pipe(map((arr) => arr.map((asg) => ({ cl, asg }))))
        )
      ).pipe(map((chunks) => chunks.flat()));
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // Join with my attempt per assignment
  rows$ = combineLatest([this.me$, this.assignments$]).pipe(
    switchMap(([me, pairs]) => {
      if (!me?.uid || !pairs.length) return of([] as Row[]);
      return combineLatest(
        pairs.map((p) =>
          this.asgn
            .attempt$(p.cl.id, (p.asg as any).id, me.uid!)
            .pipe(map((att) => ({ cl: p.cl, asg: p.asg, att })))
        )
      );
    }),
    // small quality-of-life: sort by class title then assignment title
    map((rows) =>
      rows.sort((a, b) => {
        const ca = (a.cl.title || a.cl.name || '').localeCompare(
          b.cl.title || b.cl.name || ''
        );
        if (ca !== 0) return ca;
        return (a.asg.title || '').localeCompare(b.asg.title || '');
      })
    ),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // Derived splits
  todos$ = this.rows$.pipe(
    map((rows) => rows.filter((r) => !this.isCompleted(r.att)))
  );
  dones$ = this.rows$.pipe(
    map((rows) => rows.filter((r) => this.isCompleted(r.att)))
  );

  constructor(
    private auth: AuthService,
    private classes: ClassService,
    private asgn: AssignmentService
  ) {}

  // Helpers
  isCompleted(att: QuizAttempt | null | undefined) {
    return (
      !!att &&
      (att.status === 'submitted' ||
        att.status === 'expired' ||
        typeof att.score === 'number')
    );
  }
  answeredCount(att: QuizAttempt | null | undefined) {
    if (!att?.answers?.length) return 0;
    return att.answers.filter((n) => n != null && n >= 0).length;
  }
  scorePct(att: QuizAttempt | null | undefined, total: number) {
    if (!att || typeof att.score !== 'number' || !total) return null;
    return Math.round((att.score / total) * 100);
  }
  className(cl: AnyClass) {
    return cl.title || cl.name || 'Classe';
  }
}
