import { Component, OnInit } from '@angular/core';
import { Observable, of, firstValueFrom } from 'rxjs';
import { map, switchMap, take } from 'rxjs/operators';
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
// If you already use AngularFire, prefer the @angular/fire/storage imports.
// This version uses the Firebase Web SDK directly:
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnInit {
  me$!: Observable<User | null>;
  myCourses$!: Observable<Course[]>;
  myClasses$!: Observable<ClassSection[]>;

  DEFAULT_COURSE_COVER = 'assets/img/course.jpg';
  courseCoverFile: File | null = null;
  courseCoverPreview: string | null = null;
  uploadingCover = false;

  DEFAULT_CLASS_COVER = 'assets/img/class.jpg';
  classCoverFile: File | null = null;
  classCoverPreview: string | null = null;
  uploadingClassCover = false;

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
    Observable<(ClassMember & { uid: string; user: User | null })[]>
  > = {};

  cancelingInvite: Record<string, boolean> = {};

  async cancelInvite(cl: ClassSection, inv: { id: string }) {
    if (!cl.id || !inv.id) return;
    this.cancelingInvite[inv.id] = true;
    try {
      await this.classes.cancelInvite(cl.id, inv.id);
    } finally {
      delete this.cancelingInvite[inv.id];
    }
  }

  private loadMembersFor(id: string) {
    if (!this.membersByClass[id]) {
      this.membersByClass[id] = this.classes.membersWithUsers$(id);
    }
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
  isAdmin$!: Observable<boolean>;
  ngOnInit(): void {
    this.me$ = this.auth.user$;
    this.isAdmin$ = this.auth.user$.pipe(
      map((u) => (u?.platformRole || '').toLowerCase() === 'admin')
    );

    this.myCourses$ = this.auth.user$.pipe(
      switchMap((me) => (me?.uid ? this.courses.myCourses$(me.uid) : of([])))
    );
    // dashboard.component.ts (ngOnInit)
    this.myClasses$ = this.auth.user$.pipe(
      switchMap((me) =>
        me?.uid ? this.classes.myClassesAsMember$(me.uid) : of([])
      )
    );

    // Prefill forms once classes load/change
    this.myClasses$.subscribe((classes) => {
      classes.forEach((cl) => {
        if (cl.id) {
          this.ensureInviteForm(cl.id);
          this.loadMembersFor(cl.id);
          this.loadInvitesFor(cl.id);
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
  private async requireAdmin(): Promise<boolean> {
    const ok = await firstValueFrom(this.isAdmin$.pipe(take(1)));
    if (!ok) alert('Action non autorisée.');
    return ok;
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
    this.courseCoverFile = null;
    this.courseCoverPreview = null;
    this.showCourseDialog = true;
  }
  openEditCourse(c: Course) {
    this.editCourse = c;
    this.courseForm = { title: c.title, description: c.description ?? '' };
    this.courseCoverFile = null;
    this.courseCoverPreview = c.coverUrl || null;
    this.showCourseDialog = true;
  }

  closeCourseDialog() {
    this.showCourseDialog = false;
    this.courseCoverFile = null;
    this.courseCoverPreview = null;
    this.uploadingCover = false;
  }
  async saveCourse() {
    if (!(await this.requireAdmin())) return;
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (!me?.uid) return;

    try {
      this.uploadingCover = true;

      // 1) Upload cover if selected, else fallback (or keep existing on edit)
      let coverUrl: string | undefined;

      if (this.courseCoverFile) {
        coverUrl = await this.uploadCourseCover(this.courseCoverFile, me.uid);
      } else if (this.editCourse?.coverUrl) {
        coverUrl = this.editCourse.coverUrl; // keep old on edit
      } else {
        coverUrl = this.DEFAULT_COURSE_COVER; // fallback on create
      }

      // 2) Create or update the document with coverUrl
      if (this.editCourse?.id) {
        await this.courses.update(this.editCourse.id, {
          title: this.courseForm.title.trim(),
          description: this.courseForm.description.trim(),
          coverUrl,
        });
      } else {
        await this.courses.create({
          title: this.courseForm.title.trim(),
          description: this.courseForm.description.trim(),
          ownerId: me.uid,
          coverUrl,
        });
      }
    } finally {
      this.uploadingCover = false;
      this.showCourseDialog = false;
    }
  }

  async deleteCourse(c: Course) {
    if (!(await this.requireAdmin())) return; // admin only
    if (confirm('Supprimer ce cours ?')) this.courses.delete(c.id!);
  }

  openCreateClass(course?: Course) {
    this.isAdmin$.pipe(take(1)).subscribe((isAdmin) => {
      if (!isAdmin) {
        alert('Action non autorisée.');
        return;
      }
      this.creatingFromCourse = course ?? null;
      this.classForm.courseId = course?.id ?? '';
      this.classForm.title = course ? `${course.title} — Session` : '';
      this.classCoverFile = null; // NEW
      this.classCoverPreview = null; // NEW
      this.uploadingClassCover = false; // NEW
      this.showClassDialog = true;
    });
  }

  closeClassDialog() {
    this.showClassDialog = false;
    this.creatingFromCourse = null;
    this.classCoverFile = null; // NEW
    this.classCoverPreview = null; // NEW
    this.uploadingClassCover = false; // NEW
  }

  async saveClass() {
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (!me?.uid) return;
    const { courseId, title } = this.classForm;
    if (!courseId || !title.trim()) return;

    try {
      this.uploadingClassCover = true;

      let coverUrl: string | undefined;
      if (this.classCoverFile) {
        coverUrl = await this.uploadClassCover(this.classCoverFile, me.uid);
      } else {
        coverUrl = this.DEFAULT_CLASS_COVER; // fallback on create
      }

      await this.classes.createClass({
        courseId,
        title: title.trim(),
        instructorId: me.uid,
        coverUrl, // NEW
      });
    } finally {
      this.uploadingClassCover = false;
      this.showClassDialog = false;
      this.creatingFromCourse = null;
      this.classForm = { courseId: '', title: '' };
      this.classCoverFile = null;
      this.classCoverPreview = null;
    }
  }

  // Ensure a form exists for a class id
  private ensureInviteForm(id: string) {
    if (!this.inviteForms[id])
      this.inviteForms[id] = { email: '', role: 'student' };
  }
  // dashboard.component.ts
  invitesByClass: Record<
    string,
    Observable<{ id: string; email: string; role: Role; status: string }[]>
  > = {};

  private loadInvitesFor(id: string) {
    if (!this.invitesByClass[id]) {
      this.invitesByClass[id] = this.classes.pendingInvites$(id) as any;
    }
  }

  // Update helper to avoid complex two-way bindings in template
  updateInviteForm(id: string, patch: Partial<{ email: string; role: Role }>) {
    this.ensureInviteForm(id);
    this.inviteForms[id] = { ...this.inviteForms[id], ...patch };
  }

  // dashboard.component.ts
  async inviteByEmail(cls: ClassSection) {
    this.ensureInviteForm(cls.id!);
    const f = this.inviteForms[cls.id!];
    console.log('[ui] inviting ->', f.email, 'role:', f.role, 'class:', cls.id);

    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (me?.email && f.email.trim().toLowerCase() === me.email.toLowerCase()) {
      alert('Vous ne pouvez pas vous inviter vous-même.');
      return;
    }

    try {
      const uid = await this.classes.inviteByEmailOrCreatePending(
        cls.id!,
        f.email,
        f.role
      );
      console.log('Invite result:', uid ?? '(pending invite)');
      this.loadMembersFor(cls.id!);
      this.loadInvitesFor(cls.id!); // new, see below
      this.inviteForms[cls.id!].email = '';
      alert(uid ? 'Membre ajouté ✅' : 'Invitation en attente ✉️');
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
    // Let admin OR the class instructor delete
    const [isAdmin, me] = await Promise.all([
      firstValueFrom(this.isAdmin$.pipe(take(1))),
      firstValueFrom(this.auth.user$.pipe(take(1))),
    ]);
    const can = isAdmin || cl.instructorId === me?.uid;
    if (!can) {
      alert('Action non autorisée.');
      return;
    }

    if (
      !confirm(
        `Supprimer la classe "${cl.title}" ? (Tous les membres seront retirés)`
      )
    )
      return;
    this.deletingClass[cl.id!] = true;
    try {
      await this.classes.deleteClass(cl.id!);
    } finally {
      delete this.deletingClass[cl.id!];
    }
  }

  onCourseCoverSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    this.courseCoverFile = file;

    const reader = new FileReader();
    reader.onload = () => (this.courseCoverPreview = reader.result as string);
    reader.readAsDataURL(file);
  }

  clearCourseCover() {
    this.courseCoverFile = null;
    this.courseCoverPreview = null;
  }

  private async uploadCourseCover(
    file: File,
    ownerId: string
  ): Promise<string> {
    const storage = getStorage(); // uses default Firebase app
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `course-covers/${ownerId}/${Date.now()}-${safeName}`;
    const r = ref(storage, path);
    await uploadBytes(r, file);
    return await getDownloadURL(r);
  }

  onClassCoverSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    this.classCoverFile = file;

    const reader = new FileReader();
    reader.onload = () => (this.classCoverPreview = reader.result as string);
    reader.readAsDataURL(file);
  }

  clearClassCover() {
    this.classCoverFile = null;
    this.classCoverPreview = null;
  }

  private async uploadClassCover(file: File, ownerId: string): Promise<string> {
    const storage = getStorage();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `class-covers/${ownerId}/${Date.now()}-${safeName}`;
    const r = ref(storage, path);
    await uploadBytes(r, file);
    return await getDownloadURL(r);
  }
}
