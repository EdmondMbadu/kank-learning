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

  transferA = '';
  transferB = '';
  transferMode: 'copy' | 'move' = 'copy';
  includeStaff = false;
  transferring = false;
  transferResult: {
    added: number;
    skipped: number;
    removedFromA?: number;
  } | null = null;

  // NEW: edit state for classes
  editClass: ClassSection | null = null;

  // Add description into the form model
  classForm = { courseId: '', title: '', description: '' };

  // Track when the user explicitly removed the cover during edit
  private classCoverRemoved = false;

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
    this.me$ = this.auth.effectiveUser$;
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
    this.editClass = null; // NEW
    this.classForm = { courseId: '', title: '', description: '' }; // NEW
    this.classCoverFile = null;
    this.classCoverPreview = null;
    this.classCoverRemoved = false; // NEW
    this.uploadingClassCover = false;
  }

  async saveClass() {
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (!me?.uid) return;
    const { courseId, title, description } = this.classForm;
    if (!courseId || !title.trim()) return;

    // Permission check: creating (admin only) OR editing (admin or instructor)
    if (this.editClass) {
      const [isAdmin] = await Promise.all([
        firstValueFrom(this.isAdmin$.pipe(take(1))),
      ]);
      const can = isAdmin || this.editClass.instructorId === me.uid;
      if (!can) {
        alert('Action non autorisée.');
        return;
      }
    } else {
      const isAdmin = await firstValueFrom(this.isAdmin$.pipe(take(1)));
      if (!isAdmin) {
        alert('Action non autorisée.');
        return;
      }
    }

    try {
      this.uploadingClassCover = true;

      let coverUrl: string | undefined;

      if (this.editClass?.id) {
        // UPDATE
        // 1) Decide the final cover
        if (this.classCoverFile) {
          // new upload wins
          coverUrl = await this.uploadClassCover(this.classCoverFile, me.uid);
        } else if (this.classCoverRemoved) {
          // explicit removal → default cover
          coverUrl = this.DEFAULT_CLASS_COVER;
        } else {
          // keep old one if any, else default
          coverUrl = this.editClass.coverUrl || this.DEFAULT_CLASS_COVER;
        }

        await this.classes.updateClass(this.editClass.id, {
          title: title.trim(),
          description: (description || '').trim(),
          coverUrl,
        });
      } else {
        // CREATE
        if (this.classCoverFile) {
          coverUrl = await this.uploadClassCover(this.classCoverFile, me.uid);
        } else {
          coverUrl = this.DEFAULT_CLASS_COVER;
        }

        await this.classes.createClass({
          courseId,
          title: title.trim(),
          instructorId: me.uid,
          description: (description || '').trim(),
          coverUrl,
        });
      }
    } finally {
      this.uploadingClassCover = false;
      this.showClassDialog = false;
      this.creatingFromCourse = null;
      this.editClass = null;
      this.classForm = { courseId: '', title: '', description: '' };
      this.classCoverFile = null;
      this.classCoverPreview = null;
      this.classCoverRemoved = false;
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
    this.classCoverRemoved = true; // NEW: remember the user wants no custom cover
  }

  private async uploadClassCover(file: File, ownerId: string): Promise<string> {
    const storage = getStorage();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `class-covers/${ownerId}/${Date.now()}-${safeName}`;
    const r = ref(storage, path);
    await uploadBytes(r, file);
    return await getDownloadURL(r);
  }

  /** Prefer photo if available; else null for a fallback badge */
  avatar(u: Partial<User> | null | undefined): string | null {
    return (
      (u?.photoURL ||
        (u as any)?.photoURL ||
        (u as any)?.avatarUrl ||
        (u as any)?.picture) ??
      null
    );
  }

  /** Human-friendly full name or email/uid fallback */
  displayName(u: Partial<User> | null | undefined): string {
    if (!u) return '—';
    const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return full || u['firstName'] || u['email'] || '—';
  }

  /** Build initials from a display string */
  initialsFromName(name: string | null | undefined): string {
    const s = (name || '').trim();
    if (!s) return '—';
    const parts = s.split(/\s+/).slice(0, 2);
    return parts
      .map((p) => p[0])
      .join('')
      .toUpperCase();
  }

  openEditClass(cl: ClassSection) {
    // permissions: admin OR instructor of that class
    Promise.all([
      firstValueFrom(this.isAdmin$.pipe(take(1))),
      firstValueFrom(this.auth.user$.pipe(take(1))),
    ]).then(([isAdmin, me]) => {
      const can = isAdmin || cl.instructorId === me?.uid;
      if (!can) {
        alert('Action non autorisée.');
        return;
      }
      this.editClass = cl;
      this.creatingFromCourse = null;

      this.classForm = {
        courseId: cl.courseId || '',
        title: cl.title || '',
        description: cl.description || '',
      };

      // cover preview shows existing cover if any
      this.classCoverFile = null;
      this.classCoverPreview = cl.coverUrl || null;
      this.classCoverRemoved = false;
      this.uploadingClassCover = false;

      this.showClassDialog = true;
    });
  }

  swapAB() {
    [this.transferA, this.transferB] = [this.transferB, this.transferA];
  }

  // Run transfer using ClassService
  async runTransfer() {
    if (!(await this.requireAdmin())) return;
    if (!this.transferA || !this.transferB || this.transferA === this.transferB)
      return;

    this.transferring = true;
    this.transferResult = null;

    try {
      const roles = this.includeStaff
        ? (['student', 'instructor', 'ta'] as Role[])
        : (['student'] as Role[]);
      const res = await this.classes.transferMembers({
        sourceId: this.transferA,
        destId: this.transferB,
        mode: this.transferMode,
        includeRoles: roles,
      });

      this.transferResult = res;
      // Refresh member lists for both classes so UI updates
      if (this.transferA) this.loadMembersFor(this.transferA);
      if (this.transferB) this.loadMembersFor(this.transferB);

      alert(
        `Transfert terminé ✅\nAjoutés: ${res.added}\nIgnorés: ${res.skipped}${
          this.transferMode === 'move'
            ? `\nRetirés de A: ${res.removedFromA}`
            : ''
        }`
      );
    } catch (e: any) {
      alert(e?.message || 'Erreur pendant le transfert');
    } finally {
      this.transferring = false;
    }
  }
}
