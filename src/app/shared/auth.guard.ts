// src/app/auth/auth.guard.ts
import { Injectable } from '@angular/core';
import {
  CanActivate,
  CanLoad,
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
  Route,
  UrlSegment,
  UrlTree,
  Router,
} from '@angular/router';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { Observable } from 'rxjs';
import { take, map } from 'rxjs/operators';

@Injectable({ providedIn: 'root' })
export class AuthGuard implements CanActivate, CanLoad {
  constructor(private afAuth: AngularFireAuth, private router: Router) {}

  private safeSetRedirect(url: string) {
    try {
      localStorage.setItem('auth:redirect', url);
    } catch {}
    try {
      sessionStorage.setItem('auth:redirect', url);
    } catch {}
  }

  private toLoginTree(returnUrl?: string): UrlTree {
    return this.router.createUrlTree(['/login'], {
      queryParams: returnUrl ? { returnUrl } : undefined,
      // state: returnUrl ? { returnUrl } : undefined, // <- carries state even if storage fails
    });
  }

  canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot) {
    const target = state.url;
    return this.afAuth.authState.pipe(
      take(1),
      map((user) => {
        if (user) return true;
        if (!target.startsWith('/login')) this.safeSetRedirect(target);
        return this.toLoginTree(target);
      })
    );
  }

  canLoad(route: Route, segments: UrlSegment[]) {
    const url = '/' + segments.map((s) => s.path).join('/');
    return this.afAuth.authState.pipe(
      take(1),
      map((user) => {
        if (user) return true;
        if (!url.startsWith('/login')) this.safeSetRedirect(url);
        return this.toLoginTree(url);
      })
    );
  }
}
