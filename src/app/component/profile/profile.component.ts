import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { AuthService } from 'src/app/shared/auth.service';
import { User } from 'src/app/model/user';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.component.html',
})
export class ProfileComponent implements OnInit, OnDestroy {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  me: User | null = null;
  sub?: Subscription;

  saving = false;
  status = '';

  form: {
    firstName: string;
    lastName: string;
    photoURL: string | null;
  } = {
    firstName: '',
    lastName: '',
    photoURL: null,
  };

  constructor(private auth: AuthService) {}

  ngOnInit(): void {
    this.sub = this.auth.user$.subscribe((u) => {
      this.me = u;
      this.form.firstName = u?.firstName ?? '';
      this.form.lastName = u?.lastName ?? '';
      this.form.photoURL = (u as any)?.photoURL ?? null; // ensure your User has 'photoURL'
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  initials(u?: User | null): string {
    const first = (u?.firstName || '').trim();
    const last = (u?.lastName || '').trim();
    const base = first || last ? `${first} ${last}`.trim() : u?.email ?? '';
    const parts = base.split(/[\s._-]+/).filter(Boolean);
    const a = (parts[0]?.[0] ?? 'U').toUpperCase();
    const b = (parts[1]?.[0] ?? '').toUpperCase();
    return (a + b).slice(0, 2);
  }

  triggerFile() {
    this.fileInput?.nativeElement.click();
  }

  async onFileSelected(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.me?.uid) return;

    // Optional: quick client-side validation
    if (!file.type.startsWith('image/')) {
      this.status = 'Veuillez sélectionner une image.';
      input.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      // 5 MB
      this.status = 'Image trop lourde (max 5 Mo).';
      input.value = '';
      return;
    }

    try {
      this.saving = true;
      this.status = 'Téléversement de la photo…';
      const url = await this.auth.uploadAvatar(this.me.uid, file); // implemented below
      this.form.photoURL = url;
      await this.auth.updateUserProfile(this.me.uid, { photoURL: url });
      this.status = 'Photo mise à jour ✅';
    } catch (e: any) {
      console.error(e);
      this.status = e?.message || 'Erreur lors du téléversement';
    } finally {
      this.saving = false;
      input.value = '';
    }
  }

  async removePhoto() {
    if (!this.me?.uid) return;
    try {
      this.saving = true;
      await this.auth.updateUserProfile(this.me.uid, { photoURL: '' });
      this.form.photoURL = null;
      this.status = 'Photo supprimée. Avatar par défaut utilisé.';
    } catch (e: any) {
      console.error(e);
      this.status = e?.message || 'Impossible de retirer la photo';
    } finally {
      this.saving = false;
    }
  }

  async save() {
    if (!this.me?.uid) return;
    this.saving = true;
    this.status = 'Enregistrement…';
    try {
      const patch = {
        firstName: (this.form.firstName || '').trim(),
        lastName: (this.form.lastName || '').trim(),
        displayName: `${(this.form.firstName || '').trim()} ${(
          this.form.lastName || ''
        ).trim()}`.trim(),
      };
      await this.auth.updateUserProfile(this.me.uid, patch);
      this.status = 'Profil mis à jour ✅';
    } catch (e: any) {
      console.error(e);
      this.status = e?.message || 'Erreur lors de la mise à jour';
    } finally {
      this.saving = false;
    }
  }

  reload() {
    // in case you want a manual refresh (if your AuthService exposes one)
    // otherwise this is optional since user$ is reactive
    this.status = 'Rechargé.';
  }
}
