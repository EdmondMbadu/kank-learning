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

type TransferMode = 'copy' | 'move' | 'remove';
type PanelKey = 'courses' | 'transfer' | 'csv' | 'classes';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnInit {
  me$!: Observable<User | null>;
  myCourses$!: Observable<Course[]>;
  myClasses$!: Observable<ClassSection[]>;

  // --- Collapsible panels state ---
  panelOpen: Record<PanelKey, boolean> = {
    courses: false,
    transfer: false,
    csv: false,
    classes: false,
  };

  private PANELS_KEY = 'dash.panels.v1';

  // CSV import state
  csvTargetClassId = '';
  csvRole: Role = 'student';
  csvInviteEmails = true;

  // ---- CSV helpers (hardened) ----

  private MAX_CSV_BYTES = 1_000_000; // 1 MB safety cap

  csvFileText: string | null = null;
  csvFileName = '';
  importingCsv = false;

  csvImportResult: {
    addedExisting: number;
    invitedEmails: number;
    alreadyMembers: number;
    skippedUnknownUsernames: number;
    invalidTokens: number;
    totalParsed: number;
  } | null = null;

  transferA = '';
  transferB = '';
  transferMode: TransferMode = 'copy';
  includeStaff = false;
  transferring = false;
  transferResult: {
    added: number;
    skipped: number;
    removedFromA?: number;
  } | null = null;

  // Removal UI state
  removalCandidates: Array<{
    uid: string;
    name: string;
    email?: string;
    role: Role;
  }> = [];
  selectedToRemove: Record<string, boolean> = {};
  candidateCount = 0;
  selectedCount = 0;

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

  togglePanel(k: PanelKey) {
    this.panelOpen[k] = !this.panelOpen[k];
    this.persistPanels();
  }

  private persistPanels() {
    try {
      localStorage.setItem(this.PANELS_KEY, JSON.stringify(this.panelOpen));
    } catch {}
  }

  private restorePanels() {
    try {
      const raw = localStorage.getItem(this.PANELS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<PanelKey, boolean>>;
      (Object.keys(this.panelOpen) as PanelKey[]).forEach((k) => {
        if (typeof parsed[k] === 'boolean') this.panelOpen[k] = parsed[k]!;
      });
    } catch {}
  }

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
    this.restorePanels();
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
  async removeMember(
    cl: ClassSection,
    m: { uid: string; role?: any; user?: Partial<User> | null }
  ) {
    if (!cl.id) return;

    // Build a friendly name for the dialog
    const name =
      (m.user && this.displayName(m.user)) || m.uid || 'cet utilisateur';

    // Extra warning for staff roles
    let msg = `Retirer ${name} de « ${cl.title || 'cette classe'} » ?`;
    if (m.role && String(m.role).toLowerCase() !== 'student') {
      msg += `\n⚠️ Rôle: ${String(m.role).toUpperCase()}.`;
    }

    // Confirm first — bail out if cancelled
    if (!confirm(msg)) return;

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

  async runTransfer() {
    if (!(await this.requireAdmin())) return;
    if (!this.transferA || !this.transferB || this.transferA === this.transferB)
      return;

    // Narrow the union for TypeScript:
    if (this.transferMode === 'remove') return;

    this.transferring = true;
    this.transferResult = null;

    try {
      const roles = this.includeStaff
        ? (['student', 'instructor', 'ta'] as Role[])
        : (['student'] as Role[]);

      const res = await this.classes.transferMembers({
        sourceId: this.transferA,
        destId: this.transferB,
        mode: this.transferMode, // now narrowed to 'copy' | 'move'
        includeRoles: roles,
      });

      this.transferResult = res;
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

  public async rebuildRemovalCandidates() {
    if (!this.transferA || this.transferMode !== 'remove') {
      this.removalCandidates = [];
      this.selectedToRemove = {};
      this.candidateCount = this.selectedCount = 0;
      return;
    }

    // ensure stream exists
    this.loadMembersFor(this.transferA);

    // one-shot read from existing observable
    const members = await firstValueFrom(
      this.membersByClass[this.transferA].pipe(take(1))
    );

    const allowRoles: Role[] = this.includeStaff
      ? (['student', 'instructor', 'ta'] as Role[])
      : ['student'];
    const list = (members || [])
      .filter((m) => allowRoles.includes((m.role || 'student') as Role))
      .map((m) => ({
        uid: m.uid,
        name: this.displayName(m.user),
        email: (m.user as any)?.email,
        role: (m.role || 'student') as Role,
      }));

    this.removalCandidates = list;
    // Preselect everyone
    this.selectedToRemove = {};
    list.forEach((m) => (this.selectedToRemove[m.uid] = true));

    this.candidateCount = list.length;
    this.selectedCount = list.length;
  }

  selectAllRemoval(on: boolean) {
    this.removalCandidates.forEach((m) => (this.selectedToRemove[m.uid] = on));
    this.selectedCount = on ? this.candidateCount : 0;
  }

  onIncludeStaffChanged() {
    // when checkbox toggles, rebuild if we are in remove mode
    if (this.transferMode === 'remove') this.rebuildRemovalCandidates();
  }

  onModeChanged() {
    // whenever mode changes, rebuild/clear
    this.rebuildRemovalCandidates();
  }

  // keep counters in sync if user clicks individual checkboxes
  ngDoCheck() {
    if (this.transferMode === 'remove' && this.removalCandidates.length) {
      const before = this.selectedCount;
      this.selectedCount = this.removalCandidates.reduce(
        (acc, m) => acc + (this.selectedToRemove[m.uid] ? 1 : 0),
        0
      );
      if (before !== this.selectedCount) {
        // no-op; the UI will re-render counts
      }
    }
  }

  async runBulkRemoval() {
    if (!(await this.requireAdmin())) return;
    if (!this.transferA) return;

    const selectedUids = this.removalCandidates
      .filter((m) => this.selectedToRemove[m.uid])
      .map((m) => m.uid);

    if (selectedUids.length === 0) {
      alert('Aucun membre sélectionné.');
      return;
    }

    const confirmMsg =
      `Supprimer ${selectedUids.length} membre(s) de la classe sélectionnée ?\n` +
      (this.includeStaff
        ? '⚠️ Les instructeurs/TA sélectionnés seront aussi retirés.'
        : '');
    if (!confirm(confirmMsg)) return;

    this.transferring = true;
    this.transferResult = null;

    try {
      const removed = await this.classes.bulkRemoveMembers(
        this.transferA,
        selectedUids
      );
      this.transferResult = { added: 0, skipped: 0, removedFromA: removed };
      this.loadMembersFor(this.transferA);
      await this.rebuildRemovalCandidates(); // refresh list after deletion
      alert(`Suppression terminée ✅\nRetirés de A: ${removed}`);
    } catch (e: any) {
      alert(e?.message || 'Erreur pendant la suppression');
    } finally {
      this.transferring = false;
    }
  }

  private isLikelyCsvFile(file: File): boolean {
    // some browsers don't set type; prefer name check as well
    const nameOk = /\.csv$/i.test(file.name);
    const typeOk = /^(text\/csv|text\/plain|application\/vnd\.ms-excel)$/i.test(
      file.type || ''
    );
    return nameOk || typeOk;
  }

  onCsvFileSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;

    // Basic guards to avoid loading binary formats by mistake
    if (!this.isLikelyCsvFile(file)) {
      alert(
        'Le fichier sélectionné ne semble pas être un CSV. Exportez au format .csv depuis Excel/Sheets.'
      );
      input.value = '';
      return;
    }
    if (file.size > this.MAX_CSV_BYTES) {
      alert(
        `Fichier CSV trop volumineux (${Math.round(
          file.size / 1024
        )} KB). Limite ≈ ${Math.round(this.MAX_CSV_BYTES / 1024)} KB.`
      );
      input.value = '';
      return;
    }

    this.csvFileName = file.name;

    const reader = new FileReader();
    reader.onload = () => {
      let text = String(reader.result || '');

      // Strip BOM if present
      text = text.replace(/^\uFEFF/, '');

      // Quick sanity: if the text contains tons of NULs or non-text characters,
      // it's probably a binary file opened as text.
      const nonTextRatio =
        (text.match(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g)?.length || 0) /
        Math.max(1, text.length);
      if (nonTextRatio > 0.1) {
        alert(
          'Le fichier ne semble pas être du texte pur (probablement un fichier binaire comme .xlsx). Réexportez en .csv.'
        );
        input.value = '';
        return;
      }

      this.csvFileText = text;

      // Optional: preview in console to debug
      const lines = this.splitLines(text);
      console.debug(
        '[CSV] bytes=',
        text.length,
        'lines=',
        lines.length,
        'first line preview=',
        (lines[0] || '').slice(0, 120)
      );
    };
    reader.readAsText(file);
  }

  private splitLines(text: string): string[] {
    // robust line split: CRLF | LF | CR
    return text.split(/\r\n|\n|\r/);
  }

  private detectSeparator(sampleLine: string): ',' | ';' | '\t' {
    // detect by count
    const counts = {
      ',': (sampleLine.match(/,/g) || []).length,
      ';': (sampleLine.match(/;/g) || []).length,
      '\t': (sampleLine.match(/\t/g) || []).length,
    };
    let sep: ',' | ';' | '\t' = ',';
    let best = -1;
    (Object.keys(counts) as Array<',' | ';' | '\t'>).forEach((k) => {
      if (counts[k] > best) {
        best = counts[k];
        sep = k;
      }
    });
    return sep;
  }

  private unquote(cell: string): string {
    let c = cell.trim();
    if (c.startsWith('"') && c.endsWith('"')) {
      c = c.slice(1, -1).replace(/""/g, '"'); // RFC4180
    }
    return c.trim();
  }

  private parseCsvTokens(text: string): {
    emails: string[];
    usernames: string[];
    invalid: string[];
    total: number;
  } {
    const lines = this.splitLines(text)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!lines.length)
      return { emails: [], usernames: [], invalid: [], total: 0 };

    // Separator detection on the first *non-empty* line
    const sep = this.detectSeparator(lines[0]);

    // Header detection
    const headerCells = lines[0]
      .split(sep)
      .map((x) => this.unquote(x).toLowerCase());
    const hasHeader = headerCells.some(
      (h) =>
        h === 'email' ||
        h === 'emails' ||
        h === 'username' ||
        h === 'user' ||
        h === 'login'
    );

    const emails: string[] = [];
    const usernames: string[] = [];
    const invalid: string[] = [];

    const start = hasHeader ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      const raw = lines[i];
      const cells = raw
        .split(sep)
        .map((c) => this.unquote(c))
        .filter((c) => c.length > 0);

      // If header: prefer named columns
      if (hasHeader) {
        const eIdx = headerCells.findIndex(
          (h) => h === 'email' || h === 'emails'
        );
        const uIdx = headerCells.findIndex(
          (h) => h === 'username' || h === 'user' || h === 'login'
        );

        const take = (idx: number | -1) =>
          idx >= 0 && idx < cells.length ? cells[idx] : '';

        const e = take(eIdx);
        const u = take(uIdx);

        if (e) {
          const t = e.toLowerCase();
          this.isEmail(t) ? emails.push(t) : invalid.push(t);
          continue;
        }
        if (u) {
          this.isEmail(u) ? emails.push(u.toLowerCase()) : usernames.push(u);
          continue;
        }
        // Fall through to “treat all cells”
      }

      // No header mapping — treat every cell in the row as token
      for (const token of cells) {
        if (this.isEmail(token)) emails.push(token.toLowerCase());
        else usernames.push(token);
      }
    }

    // De-dupe but keep order
    const dedupe = (arr: string[]) => Array.from(new Set(arr));
    return {
      emails: dedupe(emails),
      usernames: dedupe(usernames),
      invalid: dedupe(invalid),
      total: lines.length - start,
    };
  }

  private isEmail(s: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
  }

  async runCsvImport() {
    if (!(await this.requireAdmin())) return;
    if (!this.csvTargetClassId || !this.csvFileText) return;

    this.importingCsv = true;
    this.csvImportResult = null;

    try {
      const { emails, usernames, invalid, total } = this.parseCsvTokens(
        this.csvFileText
      );

      const TOKEN_CAP = 2000;
      const tokenCount = emails.length + usernames.length;
      if (tokenCount > TOKEN_CAP) {
        throw new Error(
          `Ce CSV contient ${tokenCount} entrées (> ${TOKEN_CAP}). Vérifiez que le fichier est bien un .csv texte.`
        );
      }

      console.debug('[CSV parsed]', {
        total,
        emails: emails.length,
        usernames: usernames.length,
        invalid: invalid.length,
      });

      // --- Feature-detect optional helpers on ClassService ---
      const svc: any = this.classes as any;
      const canResolveEmail = typeof svc.resolveUidByEmail === 'function';
      const canResolveUsername = typeof svc.resolveUidByUsername === 'function';
      const canBulkAdd = typeof svc.bulkAddMembers === 'function';

      // Stats we’ll report
      let addedExisting = 0;
      let invitedEmails = 0;
      let alreadyMembers = 0;
      let skippedUnknownUsernames = 0;

      // Always refresh streams after we’re done
      const refreshStreams = () => {
        this.loadMembersFor(this.csvTargetClassId);
        this.loadInvitesFor(this.csvTargetClassId);
      };

      // -------- FULL MODE (preferred) --------
      if (canResolveEmail && canBulkAdd) {
        // Build a set of current members to avoid duplicate writes
        this.loadMembersFor(this.csvTargetClassId);
        const currentMembers =
          (await firstValueFrom(
            this.membersByClass[this.csvTargetClassId].pipe(take(1))
          )) || [];
        const existingUids = new Set(currentMembers.map((m: any) => m.uid));

        const toAdd: { uid: string; role: Role }[] = [];

        // Resolve usernames → uid (only add if found)
        for (const uname of usernames) {
          if (!canResolveUsername) {
            skippedUnknownUsernames++;
            continue;
          }
          const uid = await svc.resolveUidByUsername(uname);
          if (uid) {
            if (!existingUids.has(uid)) {
              toAdd.push({ uid, role: this.csvRole });
              existingUids.add(uid);
            } else {
              alreadyMembers++;
            }
          } else {
            skippedUnknownUsernames++;
          }
        }

        // Emails: resolve by email first; add if account exists, else invite if toggle enabled
        for (const email of emails) {
          const uid = await svc.resolveUidByEmail(email);
          if (uid) {
            if (!existingUids.has(uid)) {
              toAdd.push({ uid, role: this.csvRole });
              existingUids.add(uid);
            } else {
              alreadyMembers++;
            }
          } else if (this.csvInviteEmails) {
            await this.classes.inviteByEmailOrCreatePending(
              this.csvTargetClassId,
              email,
              this.csvRole
            );
            invitedEmails++;
          } else {
            // Toggle off → skip unknown emails
          }
        }

        // Batch add all resolvable accounts
        if (toAdd.length) {
          addedExisting += await svc.bulkAddMembers(
            this.csvTargetClassId,
            toAdd
          );
        }

        refreshStreams();
      }
      // -------- FALLBACK MODE (no resolvers) --------
      else {
        if (!this.csvInviteEmails && emails.length) {
          alert(
            "Pour ne pas inviter les emails sans compte, ajoutez 'resolveUidByEmail' + 'bulkAddMembers' dans ClassService (voir mon message précédent)."
          );
          // We abort to respect the toggle; remove this return if you prefer inviting anyway.
          return;
        }

        // We can still process emails via your existing invite method:
        for (const email of emails) {
          try {
            const uidOrNull = await this.classes.inviteByEmailOrCreatePending(
              this.csvTargetClassId,
              email,
              this.csvRole
            );
            if (uidOrNull) addedExisting++;
            else invitedEmails++;
          } catch (err: any) {
            const msg = String(err?.message || '');
            // Try to classify "already a member" as a soft-duplicate
            if (/already|existe|dupli/i.test(msg)) {
              alreadyMembers++;
            } else {
              throw err;
            }
          }
        }

        // Without resolvers we can’t map usernames → uid, so we skip them
        skippedUnknownUsernames += usernames.length;

        refreshStreams();
      }

      // Report & bind to UI
      this.csvImportResult = {
        addedExisting,
        invitedEmails,
        alreadyMembers,
        skippedUnknownUsernames,
        invalidTokens: invalid.length,
        totalParsed: total,
      };

      alert(
        `Import terminé ✅\n` +
          `Ajoutés (comptes existants): ${addedExisting}\n` +
          `Invitations (emails): ${invitedEmails}\n` +
          `Déjà membres: ${alreadyMembers}\n` +
          `Usernames introuvables: ${skippedUnknownUsernames}\n` +
          `Entrées invalides: ${invalid.length}`
      );
    } catch (e: any) {
      console.error('CSV import error:', e);
      alert(e?.message || 'Erreur lors de l’import CSV');
    } finally {
      this.importingCsv = false;
    }
  }
}
