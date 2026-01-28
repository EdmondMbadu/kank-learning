// src/app/services/auth.service.ts
import { Injectable } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import {
  AngularFirestore,
  AngularFirestoreDocument,
} from '@angular/fire/compat/firestore';
import {
  BehaviorSubject,
  combineLatest,
  firstValueFrom,
  Observable,
  of,
} from 'rxjs';
import { map, shareReplay, switchMap, take } from 'rxjs/operators';
import { AngularFireStorage } from '@angular/fire/compat/storage'; // ✅ NEW
import { AngularFireFunctions } from '@angular/fire/compat/functions';
import { User } from '../model/user';
import { getApps, initializeApp } from '@angular/fire/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  updateEmail,
  updatePassword,
  updateProfile,
} from '@angular/fire/auth';
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from '@angular/fire/firestore';
import { norm, sanitizeUsername } from './username.util';
// { uid?, email?, firstName?, lastName? }

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: Observable<User | null>;
  currentUser: any;

  constructor(
    private afAuth: AngularFireAuth,
    private afs: AngularFirestore,
    private router: Router,
    private storage: AngularFireStorage,
    private route: ActivatedRoute,
    private fns: AngularFireFunctions
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
  private sanitizeRedirect(url?: string | null): string | null {
    if (!url) return null;
    if (!url.startsWith('/')) return null;
    if (url.startsWith('/login') || url.startsWith('/verify-email'))
      return null;
    return url;
  }

  private consumeRedirect(): string | null {
    // 1) Router state (if this navigation provided one)
    const nav = this.router.getCurrentNavigation();
    const fromState = this.sanitizeRedirect(
      (nav?.extras?.state as { returnUrl?: string } | undefined)?.returnUrl ??
        (window.history?.state as { returnUrl?: string } | undefined)?.returnUrl // also try the browser's history state
    );
    if (fromState) return fromState;

    // 2) Query param on the current route (covers hard reload at /login?returnUrl=...)
    const fromQuery = this.sanitizeRedirect(
      this.route?.snapshot?.queryParamMap?.get('returnUrl')
    );
    if (fromQuery) return fromQuery;

    // 3) sessionStorage
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem('auth:redirect');
    } catch {}
    const fromSession = this.sanitizeRedirect(raw);
    if (fromSession) {
      try {
        sessionStorage.removeItem('auth:redirect');
      } catch {}
      return fromSession;
    }

    // 4) localStorage
    try {
      raw = localStorage.getItem('auth:redirect');
    } catch {}
    const fromLocal = this.sanitizeRedirect(raw);
    if (fromLocal) {
      try {
        localStorage.removeItem('auth:redirect');
      } catch {}
      return fromLocal;
    }
    return null;
  }

  async login(
    email: string,
    password: string,
    returnUrlOverride?: string
  ): Promise<void> {
    const cred = await this.afAuth.signInWithEmailAndPassword(email, password);
    this.clearActivePersona();
    try {
      localStorage.setItem('token', 'true');
    } catch {}

    // ⬅️ prefer the URL explicitly passed from LoginComponent
    const fromOverride = this.sanitizeRedirect(returnUrlOverride);
    const stored = fromOverride ?? this.consumeRedirect();

    if (cred.user?.emailVerified) {
      await this.router.navigateByUrl(stored || '/dashboard', {
        replaceUrl: true,
      });
    } else {
      await this.router.navigate(['/verify-email'], {
        queryParams: stored ? { returnUrl: stored } : undefined,
        replaceUrl: true,
      });
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
      this.clearActivePersona();
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

  // ---- Student login with username + code
  async loginWithUsername(
    username: string,
    code: string,
    returnUrlOverride?: string
  ) {
    const uname = sanitizeUsername(username);
    if (!uname) throw new Error('Nom d’utilisateur requis.');

    const snap = await this.afs
      .doc<{ uid: string; authEmail: string; ownerUid: string }>(
        `usernames/${uname}`
      )
      .ref.get();
    if (!snap.exists) throw new Error('Utilisateur introuvable.');

    const { authEmail } = snap.data()!;
    await this.afAuth.signInWithEmailAndPassword(authEmail, code);
    try {
      localStorage.setItem('token', 'true');
    } catch {}

    const fromOverride = this.sanitizeRedirect(returnUrlOverride);
    const stored = fromOverride ?? this.consumeRedirect();

    await this.router.navigateByUrl(stored || '/dashboard', {
      replaceUrl: true,
    });
  }

  // ---- List my child users (for admin view on profile)
  listMyChildUsers(ownerUid: string) {
    return this.afs
      .collection<User>('users', (ref) =>
        ref
          .where('ownerUid', '==', ownerUid)
          .where('isManagedChild', '==', true)
      )
      .valueChanges({ idField: 'uid' });
  }

  // ---- Create child user with username+code (client-only via SECONDARY app)
  async createChildUserForMe(params: {
    ownerUid: string;
    ownerEmail: string;
    username: string;
    code: string;
    firstName?: string;
    lastName?: string;
  }) {
    const db = this.afs.firestore;
    const uname = sanitizeUsername(params.username);
    if (!uname) throw new Error('Nom d’utilisateur invalide.');
    // 1) ensure username free
    const unameRef = this.afs.doc(`usernames/${uname}`).ref;
    const unameSnap = await unameRef.get();
    if (unameSnap.exists)
      throw new Error('Ce nom d’utilisateur est déjà pris.');

    // 2) spin up a secondary app so you don't log the admin out
    const primary = getApps()[0];
    const secondary = initializeApp(
      primary.options,
      'child-maker-' + Date.now()
    );
    const auth2 = getAuth(secondary);

    try {
      // temp email to create; becomes stable <uid>@users.local right after
      const tempEmail = `${uname}.${Date.now()}@users.local`;
      const cred = await createUserWithEmailAndPassword(
        auth2,
        tempEmail,
        params.code
      );
      const child = cred.user;
      const stableEmail = `${child.uid}@users.local`;
      await updateEmail(child, stableEmail);
      const displayName = `${params.firstName || ''} ${
        params.lastName || ''
      }`.trim();

      if (displayName) await updateProfile(child, { displayName });

      // 3) write user doc
      await setDoc(
        doc(getFirestore(secondary), 'users', child.uid),
        {
          uid: child.uid,
          isManagedChild: true,
          authEmail: stableEmail,
          username: params.username,
          usernameLower: uname,
          ownerUid: params.ownerUid,
          ownerEmailLower: norm(params.ownerEmail),
          firstName: params.firstName || '',
          lastName: params.lastName || '',
          displayName: displayName || params.username,
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // 4) username index
      await setDoc(doc(getFirestore(secondary), 'usernames', uname), {
        uid: child.uid,
        authEmail: stableEmail,
        ownerUid: params.ownerUid,
      });

      // 5) mirror to your main app as well (same db instance really)
      // (no-op; we wrote with the same backend)

      return child.uid;
    } finally {
      await signOut(auth2).catch(() => {});
    }
  }

  // ---- Change child username (no email changes needed)
  async changeChildUsername(
    ownerUid: string,
    targetUid: string,
    newUsername: string
  ) {
    const uname = sanitizeUsername(newUsername);
    if (!uname) throw new Error('Nom d’utilisateur invalide.');
    // ensure free
    const idxRef = this.afs.doc(`usernames/${uname}`).ref;
    if ((await idxRef.get()).exists) throw new Error('Nom déjà pris.');

    const userRef = this.afs.doc<User>(`users/${targetUid}`).ref;
    const snap = await userRef.get();
    if (!snap.exists) throw new Error('Utilisateur introuvable.');
    const cur = snap.data() as any;
    if (cur.ownerUid !== ownerUid || !cur.isManagedChild)
      throw new Error('Accès refusé.');

    // swap index
    const oldUname = cur.usernameLower;
    await this.afs.firestore.runTransaction(async (tx) => {
      tx.set(
        userRef,
        {
          username: newUsername,
          usernameLower: uname,
          updatedAt: serverTimestamp(),
        } as any,
        { merge: true }
      );
      tx.set(
        idxRef,
        { uid: targetUid, authEmail: cur.authEmail, ownerUid },
        { merge: true }
      );
      if (oldUname) tx.delete(this.afs.doc(`usernames/${oldUname}`).ref);
    });
  }

  // ---- Change child password IF you know the current password
  async changeChildPasswordWithCurrent(
    targetUid: string,
    currentPassword: string,
    newPassword: string
  ) {
    // fetch authEmail for that uid
    const userDoc = await this.afs.doc<User>(`users/${targetUid}`).ref.get();
    if (!userDoc.exists) throw new Error('Utilisateur introuvable.');
    const { authEmail } = userDoc.data() as any;
    if (!authEmail) throw new Error('authEmail manquant.');

    // secondary login AS the child, then update
    const primary = getApps()[0];
    const secondary = initializeApp(
      primary.options,
      'child-reset-' + Date.now()
    );
    const auth2 = getAuth(secondary);
    try {
      const cred = await signInWithEmailAndPassword(
        auth2,
        authEmail,
        currentPassword
      );
      await updatePassword(cred.user, newPassword);
    } finally {
      await signOut(auth2).catch(() => {});
    }
  }

  async deleteManagedChildUser(targetUid: string) {
    const callable = this.fns.httpsCallable('deleteManagedChild');
    await firstValueFrom(callable({ targetUid }));
  }
  private activePersonaUid$ = new BehaviorSubject<string | null>(
    localStorage.getItem('activePersonaUid') || null
  );

  //  Call this after student login (username+code) to switch persona
  setActivePersona(uid: string) {
    this.activePersonaUid$.next(uid);
    localStorage.setItem('activePersonaUid', uid);
  }

  // Clear persona on regular email login/logout
  clearActivePersona() {
    this.activePersonaUid$.next(null);
    localStorage.removeItem('activePersonaUid');
  }

  // Replace your existing `user$` if you want everything to use persona,
  // OR add these two new streams and migrate views gradually:
  effectiveUid$ = combineLatest([
    this.afAuth.authState,
    this.activePersonaUid$,
  ]).pipe(
    map(([auth, active]) => active || auth?.uid || null),
    shareReplay(1)
  );

  effectiveUser$: Observable<User | null> = this.effectiveUid$.pipe(
    switchMap((uid) => {
      if (!uid) return of(null);
      return this.afs
        .doc<User>(`users/${uid}`)
        .valueChanges()
        .pipe(
          map((doc) =>
            doc
              ? { ...doc, uid }
              : { uid, email: this.currentUser?.email ?? '' }
          )
        );
    }),
    shareReplay(1)
  );
}
