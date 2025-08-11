import { Component } from '@angular/core';
import { Observable, of } from 'rxjs';
import { map, switchMap, shareReplay } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { User } from 'src/app/model/user';

@Component({
  selector: 'app-navbar',
  templateUrl: './navbar.component.html',
})
export class NavbarComponent {
  menuOpen = false;

  // Stream of the current user (doc or auth fallback)
  me$: Observable<User | null> = this.auth.user$;

  constructor(private auth: AuthService) {}

  toggleMenu() {
    this.menuOpen = !this.menuOpen;
    document.body.style.overflow = this.menuOpen ? 'hidden' : '';
  }
  closeMenu() {
    this.menuOpen = false;
    document.body.style.overflow = '';
  }
  ngOnDestroy() {
    document.body.style.overflow = '';
  }

  logout() {
    this.auth.logout();
  }

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
}
