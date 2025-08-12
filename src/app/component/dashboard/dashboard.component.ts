import { Component, OnInit } from '@angular/core';
import { Observable, of, firstValueFrom } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';
import {
  User,
  Course,
  ClassSection,
  Role,
  ClassMember,
} from 'src/app/model/user';
import { AuthService } from 'src/app/shared/auth.service';
import { CourseService } from 'src/app/shared/course.service';
import { ClassService } from 'src/app/shared/class.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnInit {
  me$!: Observable<User | null>;
  myCourses$!: Observable<Course[]>;
  myClasses$!: Observable<ClassSection[]>;

  // Course dialog
  showCourseDialog = false;
  editCourse: Course | null = null;
  courseForm = { title: '', description: '' };

  // Class dialog
  showClassDialog = false;
  classForm = { courseId: '', title: '' };
  creatingFromCourse: Course | null = null;
  membersByClass: Record<
    string,
    Observable<(ClassMember & { uid: string })[]>
  > = {};

  private loadMembersFor(id: string) {
    if (!this.membersByClass[id])
      this.membersByClass[id] = this.classes.members$(id);
  }

  // Invite forms (per class)
  // dashboard.component.ts
  inviteForms: Record<
    string,
    { email: string; role: 'student' | 'instructor' | 'ta' }
  > = {};

  byId(_: number, c: any) {
    return c.id;
  }

  constructor(
    private auth: AuthService,
    private courses: CourseService,
    private classes: ClassService
  ) {}

  ngOnInit(): void {
    this.me$ = this.auth.user$;
    this.myCourses$ = this.auth.user$.pipe(
      switchMap((me) => (me?.uid ? this.courses.myCourses$(me.uid) : of([])))
    );
    this.myClasses$ = this.auth.user$.pipe(
      switchMap((me) =>
        me?.uid ? this.classes.myClassesAsInstructor$(me.uid) : of([])
      )
    );
    // Prefill forms once classes load/change
    this.myClasses$.subscribe((classes) => {
      classes.forEach((cl) => {
        if (cl.id) {
          this.ensureInviteForm(cl.id);
          this.loadMembersFor(cl.id);
        }
      });
    });
  }
  // Pending states
  deletingClass: Record<string, boolean> = {};
  removingMember: Record<string, Record<string, boolean>> = {}; // classId -> { uid: true }

  // TrackBy for members
  trackMember(_: number, m: any) {
    return m?.uid;
  }
  isRemoving(classId: string, uid: string) {
    return !!this.removingMember[classId]?.[uid];
  }

  // UI helpers (unchanged)
  label(u: User | null): string {
    if (!u) return '';
    if ((u.firstName ?? '') || (u.lastName ?? '')) {
      return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
    }
    return u.email ?? '';
  }
  initials(u: User | null): string {
    if (!u) return 'ME';
    const base =
      u.firstName || u.lastName
        ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
        : u.email ?? 'me';
    const parts = base.split(/[\s._-]+/).filter(Boolean);
    const a = (parts[0]?.[0] ?? 'M').toUpperCase();
    const b = (parts[1]?.[0] ?? u.email?.[0] ?? 'E').toUpperCase();
    return a + b;
  }
  friendlyName(u: User | null): string {
    if (!u) return 'collaborateur';
    const base =
      u.firstName || u.lastName
        ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
        : u.email ?? 'collaborateur';
    const cleaned = base.split('@')[0].replace(/[._-]+/g, ' ');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // --- Course dialog actions ---
  openCreateCourse() {
    this.editCourse = null;
    this.courseForm = { title: '', description: '' };
    this.showCourseDialog = true;
  }
  openEditCourse(c: Course) {
    this.editCourse = c;
    this.courseForm = { title: c.title, description: c.description ?? '' };
    this.showCourseDialog = true;
  }
  closeCourseDialog() {
    this.showCourseDialog = false;
  }
  async saveCourse() {
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (!me?.uid) return;

    if (this.editCourse?.id) {
      await this.courses.update(this.editCourse.id, {
        title: this.courseForm.title.trim(),
        description: this.courseForm.description.trim(),
      });
    } else {
      await this.courses.create({
        title: this.courseForm.title.trim(),
        description: this.courseForm.description.trim(),
        ownerId: me.uid,
      });
    }
    this.showCourseDialog = false;
  }
  deleteCourse(c: Course) {
    if (confirm('Supprimer ce cours ?')) this.courses.delete(c.id!);
  }

  // --- Class dialog actions ---
  openCreateClass(course?: Course) {
    this.creatingFromCourse = course ?? null;
    this.classForm.courseId = course?.id ?? '';
    this.classForm.title = course ? `${course.title} — Session` : '';
    this.showClassDialog = true;
  }
  closeClassDialog() {
    this.showClassDialog = false;
    this.creatingFromCourse = null;
  }
  async saveClass() {
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (!me?.uid) return;
    const { courseId, title } = this.classForm;
    if (!courseId || !title.trim()) return;

    await this.classes.createClass({
      courseId,
      title: title.trim(),
      instructorId: me.uid,
    });
    this.showClassDialog = false;
    this.creatingFromCourse = null;
    this.classForm = { courseId: '', title: '' };
  }

  // Ensure a form exists for a class id
  private ensureInviteForm(id: string) {
    if (!this.inviteForms[id])
      this.inviteForms[id] = { email: '', role: 'student' };
  }

  // Update helper to avoid complex two-way bindings in template
  updateInviteForm(id: string, patch: Partial<{ email: string; role: Role }>) {
    this.ensureInviteForm(id);
    this.inviteForms[id] = { ...this.inviteForms[id], ...patch };
  }

  // (Optional) make invite safer
  async inviteByEmail(cls: ClassSection) {
    this.ensureInviteForm(cls.id!);
    const f = this.inviteForms[cls.id!];
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (
      me?.email &&
      f.email.trim().toLowerCase() === me.email.toLowerCase() &&
      f.role !== 'instructor'
    ) {
      alert('Vous êtes déjà formateur de cette classe.');
      return;
    }
    try {
      await this.classes.inviteByEmail(cls.id!, f.email, f.role);
      this.inviteForms[cls.id!].email = '';
      alert('Invitation enregistrée ✅');
    } catch (e: any) {
      alert(e?.message || 'Erreur lors de l’invitation');
    }
  }

  onInviteEmailChange(id: string, email: string) {
    this.inviteForms[id] ??= { email: '', role: 'student' };
    this.inviteForms[id].email = email;
  }
  onInviteRoleChange(id: string, role: 'student' | 'instructor' | 'ta') {
    this.inviteForms[id] ??= { email: '', role: 'student' };
    this.inviteForms[id].role = role;
  }
  async removeMember(cl: ClassSection, m: { uid: string; role: any }) {
    if (!cl.id) return;
    this.removingMember[cl.id] ??= {};
    this.removingMember[cl.id][m.uid] = true;
    try {
      await this.classes.removeMember(cl.id, m.uid);
    } finally {
      // small timeout to let the stream update so it doesn't flicker
      setTimeout(() => {
        delete this.removingMember[cl.id!][m.uid];
      }, 150);
    }
  }

  async deleteClass(cl: ClassSection) {
    if (!cl.id) return;
    if (
      !confirm(
        `Supprimer la classe "${cl.title}" ? (Tous les membres seront retirés)`
      )
    )
      return;
    this.deletingClass[cl.id] = true;
    try {
      await this.classes.deleteClass(cl.id);
    } finally {
      delete this.deletingClass[cl.id];
    }
  }
}
