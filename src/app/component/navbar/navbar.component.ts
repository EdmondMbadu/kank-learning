import { Component, HostListener } from '@angular/core';
import { combineLatest, Observable, of } from 'rxjs';
import { map, switchMap, shareReplay } from 'rxjs/operators';
import { AuthService } from 'src/app/shared/auth.service';
import { User, UserClassIndex } from 'src/app/model/user';
import { ClassService } from 'src/app/shared/class.service';
import { MessageService } from 'src/app/shared/message.service';

@Component({
  selector: 'app-navbar',
  templateUrl: './navbar.component.html',
})
export class NavbarComponent {
  menuOpen = false;
  classesMenuOpen = false;

  // Stream of the current user (doc or auth fallback)
  me$: Observable<User | null> = this.auth.user$;

  myClassesIndex$!: Observable<UserClassIndex[]>;
  unreadTotal$!: Observable<number>;

  constructor(
    private auth: AuthService,
    private classes: ClassService,
    private messages: MessageService
  ) {
    this.me$ = this.auth.effectiveUser$;

    // navbar.component.ts (constructor)
    this.myClassesIndex$ = this.auth.effectiveUid$.pipe(
      switchMap((uid) => {
        if (!uid) return of([]);

        // First try the user-side index (fast path)
        return this.classes.userClassIndex$(uid).pipe(
          switchMap((idx) => {
            if (idx.length) return of(idx);

            // Fallback: derive an index from memberships so navbar shows up today
            return this.classes.navClasses$(uid).pipe(
              switchMap((rows) =>
                rows.length
                  ? combineLatest(
                      rows.map((r) =>
                        this.classes.memberRole$(r.id, uid).pipe(
                          map(
                            (role) =>
                              ({
                                classId: r.id,
                                title: r.title || r.id,
                                role: role || 'student',
                                status: 'active',
                              } as UserClassIndex)
                          )
                        )
                      )
                    )
                  : of([])
              )
            );
          })
        );
      }),
      shareReplay(1)
    );

    this.unreadTotal$ = combineLatest([
      this.auth.effectiveUid$,
      this.myClassesIndex$,
    ]).pipe(
      switchMap(([uid, idx]) =>
        uid && idx.length
          ? this.messages.unreadTotal$(
              uid,
              idx.map((i) => i.classId)
            )
          : of(0)
      )
    );
  }

  accountMenuOpen = false;

  toggleAccountMenu() {
    this.accountMenuOpen = !this.accountMenuOpen;
  }
  closeAccountMenu() {
    this.accountMenuOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEsc() {
    this.closeAccountMenu();
  }

  toggleClassesMenu() {
    this.classesMenuOpen = !this.classesMenuOpen;
  }
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
