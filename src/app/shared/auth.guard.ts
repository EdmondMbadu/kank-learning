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

  private toLoginTree(returnUrl?: string): UrlTree {
    return this.router.createUrlTree(['/login'], {
      queryParams: returnUrl ? { returnUrl } : undefined,
    });
  }

  canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot
  ): Observable<boolean | UrlTree> {
    const target = state.url;
    return this.afAuth.authState.pipe(
      take(1),
      map((user) => {
        if (user) return true;
        if (!target.startsWith('/login')) {
          localStorage.setItem('auth:redirect', target); // remember the deep link
        }
        return this.toLoginTree(target);
      })
    );
  }

  canLoad(route: Route, segments: UrlSegment[]): Observable<boolean | UrlTree> {
    const url = '/' + segments.map((s) => s.path).join('/');
    return this.afAuth.authState.pipe(
      take(1),
      map((user) => (user ? true : this.toLoginTree(url)))
    );
  }
}
