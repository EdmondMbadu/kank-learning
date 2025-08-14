// src/app/component/class-view/class-view.component.ts
import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject, combineLatest, firstValueFrom, of } from 'rxjs';
import { switchMap, map } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import { ClassSection, CourseModule } from 'src/app/model/user';
import { CourseService } from 'src/app/shared/course.service';
import { AssignmentService } from 'src/app/shared/assignment.service';

@Component({
  selector: 'app-class',
  templateUrl: './class.component.html',
  styleUrls: ['./class.component.css'],
})
export class ClassComponent {
  classId$ = this.route.paramMap.pipe(map((p) => p.get('id')!));

  me$ = this.auth.user$;

  class$ = this.classId$.pipe(switchMap((id) => this.classes.class$(id)));

  role$ = combineLatest([this.classId$, this.auth.user$]).pipe(
    switchMap(([id, me]) => this.classes.memberRole$(id, me?.uid))
  );

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
  // --- QUIZ streams/state ---
  assignments$ = this.classId$.pipe(
    switchMap((id) => this.asgn.assignments$(id))
  );

  // use a BehaviorSubject so the stream re-computes when you open another assignment
  openAssignmentId$ = new BehaviorSubject<string | null>(null);
  openAssignmentId: string | null = null; // keep for template if you use it

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

  constructor(
    private route: ActivatedRoute,
    private auth: AuthService,
    private classes: ClassService,
    private courses: CourseService,
    private asgn: AssignmentService // QUIZ
  ) {}

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
}
