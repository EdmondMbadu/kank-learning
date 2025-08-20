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
  asg: QuizAssignment & { id?: string; createdAt?: any; updatedAt?: any };
  att: QuizAttempt | null;
}

type TimelineItem = Row & { kind: 'todo' | 'done'; date: Date };

type DayGroup = { key: string; label: string; items: TimelineItem[] };

@Component({
  selector: 'app-activity',
  templateUrl: './activity.component.html',
})
export class ActivityComponent {
  me$ = this.auth.effectiveUser$;

  // All classes for the user (map + subcollection; merged & de-duped)
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
      if (!cls.length) {
        return of(
          [] as { cl: AnyClass; asg: QuizAssignment & { id?: string } }[]
        );
      }
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
    shareReplay({ bufferSize: 1, refCount: true })
  );

  // ===== Timeline logic =====

  // “À faire” timeline groups (newest first by last activity/assignment update)
  todoGroups$ = this.rows$.pipe(
    map((rows) =>
      rows
        .filter((r) => !this.isCompleted(r.att))
        .map((r) => ({
          ...r,
          kind: 'todo' as const,
          date: this.todoDate(r),
        }))
        .sort((a, b) => b.date.getTime() - a.date.getTime())
    ),
    map((items) => this.groupByDay(items))
  );

  // “Terminé” timeline groups (newest first by submitted/graded time)
  doneGroups$ = this.rows$.pipe(
    map((rows) =>
      rows
        .filter((r) => this.isCompleted(r.att))
        .map((r) => ({
          ...r,
          kind: 'done' as const,
          date: this.doneDate(r),
        }))
        .sort((a, b) => b.date.getTime() - a.date.getTime())
    ),
    map((items) => this.groupByDay(items))
  );

  constructor(
    private auth: AuthService,
    private classes: ClassService,
    private asgn: AssignmentService
  ) {}

  // ===== Helpers =====

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

  // Pick a good "last-activity" date for TODOS
  private todoDate(r: Row): Date {
    const att = r.att as any;
    return (
      this.toDate(att?.updatedAt) ||
      this.toDate(att?.startedAt) ||
      this.toDate((r.asg as any)?.updatedAt) ||
      this.toDate((r.asg as any)?.createdAt) ||
      new Date(0)
    );
  }

  // Pick a good "completion" date for DONE
  private doneDate(r: Row): Date {
    const att = r.att as any;
    return (
      this.toDate(att?.submittedAt) ||
      this.toDate(att?.gradedAt) ||
      this.toDate(att?.updatedAt) ||
      this.toDate(att?.startedAt) ||
      new Date(0)
    );
  }

  private toDate(v: any): Date | null {
    if (!v) return null;
    // Firestore Timestamp / compat / plain Date
    if (typeof v?.toDate === 'function') return v.toDate();
    if (v?.seconds) return new Date(v.seconds * 1000);
    if (v instanceof Date) return v;
    return null;
  }

  private groupByDay(items: TimelineItem[]): DayGroup[] {
    const by: Record<string, TimelineItem[]> = {};
    for (const it of items) {
      const d = new Date(it.date);
      const key = `${d.getFullYear()}-${(d.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
      (by[key] ||= []).push(it);
    }
    const entries = Object.entries(by).map(([key, arr]) => ({
      key,
      label: this.dayLabel(arr[0]?.date || new Date()),
      items: arr.sort((a, b) => b.date.getTime() - a.date.getTime()),
    }));
    // newest day first
    return entries.sort(
      (a, b) =>
        new Date(b.items[0].date).getTime() -
        new Date(a.items[0].date).getTime()
    );
  }

  private dayLabel(d: Date): string {
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);

    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();

    if (sameDay(d, today)) return 'Aujourd’hui';
    if (sameDay(d, yest)) return 'Hier';

    return d.toLocaleDateString('fr-FR', {
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  }
}
