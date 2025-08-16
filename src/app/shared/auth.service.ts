// src/app/services/auth.service.ts
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import {
  AngularFirestore,
  AngularFirestoreDocument,
} from '@angular/fire/compat/firestore';
import { firstValueFrom, Observable, of } from 'rxjs';
import { map, shareReplay, switchMap, take } from 'rxjs/operators';
import { AngularFireStorage } from '@angular/fire/compat/storage'; // ✅ NEW
import { User } from '../model/user';
// { uid?, email?, firstName?, lastName? }

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: Observable<User | null>;
  currentUser: any;

  constructor(
    private afAuth: AngularFireAuth,
    private afs: AngularFirestore,
    private router: Router,
    private storage: AngularFireStorage
  ) {
    // Read Firestore user doc when auth state changes
    this.user$ = this.afAuth.authState.pipe(
      switchMap((auth) => {
        if (!auth) return of(null);
        return this.afs
          .doc<User>(`users/${auth.uid}`)
          .valueChanges()
          .pipe(
            // If the doc doesn't exist yet, fall back to auth info
            map((doc) => doc ?? { uid: auth.uid, email: auth.email ?? '' })
          );
      }),
      shareReplay(1) // cache latest for multiple subscribers
    );

    this.user$.subscribe((u) => (this.currentUser = u));
  }

  // -------- AUTH --------
  async login(email: string, password: string): Promise<void> {
    try {
      const cred = await this.afAuth.signInWithEmailAndPassword(
        email,
        password
      );

      localStorage.setItem('token', 'true');

      if (cred.user?.emailVerified) {
        await this.router.navigate(['/dashboard']); // ← go to home after login
      } else {
        await this.router.navigate(['/verify-email']);
      }
    } catch (err: any) {
      alert(err?.message || 'Une erreur est survenue.');
      // don't navigate here; let the component decide
      throw err; // ← lets the component turn off loading properly
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
        emailLower: (email || '').toLowerCase(),
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
      await this.router.navigate(['/']);
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

  /**
   * Upload an avatar to Firebase Storage and return a public download URL.
   */
  async uploadAvatar(uid: string, file: File): Promise<string> {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `users/${uid}/avatar_${Date.now()}.${ext}`; // cache-busting filename
    const task = await this.storage.upload(path, file, {
      contentType: file.type,
    });
    const ref = this.storage.ref(task.ref.fullPath);
    const url = await firstValueFrom(ref.getDownloadURL());
    return url;
  }

  /**
   * Merge profile fields into Firestore user doc and (optionally) sync Firebase Auth profile.
   * Pass only the fields you intend to change.
   *
   * Example patch: { firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace', photoURL: 'https://...' }
   */
  async updateUserProfile(
    uid: string,
    patch: Partial<User> & { displayName?: string; photoURL?: string | null }
  ): Promise<void> {
    // 1) Merge into Firestore
    const ref = this.afs.doc<User>(`users/${uid}`);
    await ref.set(patch as any, { merge: true });

    // 2) If relevant fields are included, sync Firebase Auth profile too
    const authUser = await this.afAuth.currentUser;
    if (authUser && authUser.uid === uid) {
      const changes: any = {};
      if ('displayName' in patch)
        changes.displayName = patch.displayName ?? null;
      if ('photoURL' in patch) changes.photoURL = patch.photoURL ?? null;

      if (Object.keys(changes).length) {
        // compat user has updateProfile
        await authUser.updateProfile(changes);
      }
    }
  }
}
