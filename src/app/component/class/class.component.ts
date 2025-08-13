// src/app/component/class-view/class-view.component.ts
import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { combineLatest, of } from 'rxjs';
import { switchMap, map } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { ClassService } from 'src/app/shared/class.service';
import { ClassSection, CourseModule } from 'src/app/model/user';
import { CourseService } from 'src/app/shared/course.service';

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

  members$ = this.classId$.pipe(switchMap((id) => this.classes.members$(id)));

  // invite form state
  invite = { email: '', role: 'student' as 'student' | 'instructor' | 'ta' };
  inviting = false;

  // remove state
  removing: Record<string, boolean> = {};
  canceling: Record<string, boolean> = {}; // NEW: cancel pending invite

  constructor(
    private route: ActivatedRoute,
    private auth: AuthService,
    private classes: ClassService,
    private courses: CourseService
  ) {}

  async inviteMember(classId: string) {
    if (!this.invite.email) return;
    this.inviting = true;
    try {
      await this.classes.inviteByEmail(
        classId,
        this.invite.email,
        this.invite.role
      );
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
}
