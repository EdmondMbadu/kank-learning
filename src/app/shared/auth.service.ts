// src/app/services/auth.service.ts
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import {
  AngularFirestore,
  AngularFirestoreDocument,
} from '@angular/fire/compat/firestore';
import { Observable, of } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';
import { User } from '../model/user';
// { uid?, email?, firstName?, lastName? }

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: Observable<any>;
  currentUser: any;

  constructor(
    private afAuth: AngularFireAuth,
    private afs: AngularFirestore,
    private router: Router
  ) {
    // Read Firestore user doc when auth state changes
    this.user$ = this.afAuth.authState.pipe(
      switchMap((auth) => {
        if (!auth) return of(null);
        return this.afs.doc<User>(`users/${auth.uid}`).valueChanges();
      })
    );
    this.user$.subscribe((u) => (this.currentUser = u));
  }

  // -------- AUTH --------

  async login(email: string, password: string) {
    try {
      const cred = await this.afAuth.signInWithEmailAndPassword(
        email,
        password
      );

      // No Firestore writes here — just route
      localStorage.setItem('token', 'true');
      if (cred.user?.emailVerified) {
        await this.router.navigate(['/dashboard']);
      } else {
        await this.router.navigate(['/verify-email']);
      }
    } catch (err: any) {
      alert(err?.message || 'Something went wrong');
      this.router.navigate(['/login']);
    }
  }

  async register(
    email: string,
    password: string,
    firstName?: string,
    lastName?: string
  ) {
    try {
      const cred = await this.afAuth.createUserWithEmailAndPassword(
        email,
        password
      );

      // Create the Firestore user doc ONCE (no undefined fields)
      await this.createUserDoc(cred.user!.uid, {
        uid: cred.user!.uid,
        email,
        firstName: firstName ?? '',
        lastName: lastName ?? '',
      });

      await this.sendEmailForVerification(cred.user);
      await this.router.navigate(['/verify-email']);
      alert('Registration was Successful');
    } catch (err: any) {
      alert(err?.message || 'Registration failed');
      this.router.navigate(['/register']);
    }
  }

  async logout() {
    try {
      await this.afAuth.signOut();
      localStorage.removeItem('token');
      await this.router.navigate(['/login']);
    } catch (err: any) {
      alert(err?.message || 'Something went wrong');
    }
  }

  async forgotPassword(email: string) {
    try {
      await this.afAuth.sendPasswordResetEmail(email);
      await this.router.navigate(['verify-email']);
    } catch {
      alert('Something went wrong');
    }
  }

  async sendEmailForVerification(user: any) {
    try {
      await user.sendEmailVerification();
      await this.router.navigate(['verify-email']);
    } catch {
      alert('Something went wrong. Unable to send you an email');
    }
  }

  // -------- FIRESTORE HELPERS (simple) --------

  /** Create the Firestore user doc if it doesn't exist yet. */
  private async createUserDoc(uid: string, data: User) {
    const ref: AngularFirestoreDocument<User> = this.afs.doc(`users/${uid}`);
    const snap = await ref.ref.get();
    if (!snap.exists) {
      // data has no undefined fields (uid/email/firstName/lastName are set)
      await ref.set(data, { merge: true });
    }
    // If it exists already, we do nothing (keep it simple)
  }

  /** One-shot fetch if you need it somewhere */
  async getUserOnce(): Promise<User | null> {
    const auth = await this.afAuth.authState.pipe(take(1)).toPromise();
    if (!auth) return null;
    const ref = this.afs.doc<User>(`users/${auth.uid}`);
    const snap = await ref.ref.get();
    return snap.exists ? (snap.data() as User) : null;
  }

  /** Update a single field on current user */
  async setUserField(field: keyof User, value: User[typeof field]) {
    const auth = await this.afAuth.authState.pipe(take(1)).toPromise();
    if (!auth) return;
    const ref = this.afs.doc<User>(`users/${auth.uid}`);
    // Avoid undefined
    if (value === undefined) return;
    await ref.set({ [field]: value } as Partial<User> as User, { merge: true });
  }
}
