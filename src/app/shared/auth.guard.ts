// src/app/auth/auth.guard.ts
import { Injectable } from '@angular/core';
import {
  CanActivate,
  CanLoad,
  Route,
  UrlSegment,
  Router,
  UrlTree,
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
} from '@angular/router';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { map, take } from 'rxjs/operators';
import { Observable } from 'rxjs';

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
    return this.afAuth.authState.pipe(
      take(1),
      map((user) => (user ? true : this.toLoginTree(state.url)))
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
