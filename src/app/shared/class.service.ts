// src/app/shared/class.service.ts
import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';

import {
  getFirestore,
  collection,
  doc,
  getDocs,
  writeBatch,
  setDoc,
  deleteDoc,
  serverTimestamp,
  query,
  where,
} from 'firebase/firestore';
import firebase from 'firebase/compat/app';
import { combineLatest, of, switchMap } from 'rxjs';
import { map } from 'rxjs';
import { Observable } from 'rxjs';
import {
  ClassSection,
  ClassMember,
  Role,
  UserClassIndex,
  User,
} from 'src/app/model/user';

type PendingInvite = {
  id?: string;
  email: string; // lowercased
  role: Role;
  status: 'pending' | 'accepted' | 'canceled';
  createdAt: any;
  invitedBy?: string; // optional
};

@Injectable({ providedIn: 'root' })
export class ClassService {
  constructor(private afs: AngularFirestore) {}

  myClassesAsInstructor$(uid: string): Observable<ClassSection[]> {
    return this.afs
      .collection<ClassSection>('classes', (ref) =>
        ref.where('instructorId', '==', uid).orderBy('createdAt', 'desc')
      )
      .valueChanges({ idField: 'id' });
  }
  class$(id: string): Observable<ClassSection | null | undefined> {
    return this.afs
      .doc<ClassSection>(`classes/${id}`)
      .valueChanges({ idField: 'id' });
  }

  memberRole$(
    classId: string,
    uid?: string | null
  ): Observable<'instructor' | 'ta' | 'student' | null> {
    if (!uid) return of(null);
    return this.afs
      .doc<ClassMember>(`classes/${classId}/members/${uid}`)
      .valueChanges()
      .pipe(map((m) => (m?.role as any) ?? null));
  }

  members$(classId: string): Observable<(ClassMember & { uid: string })[]> {
    return this.afs
      .collection<ClassMember>(`classes/${classId}/members`, (ref) =>
        ref.orderBy('role')
      )
      .valueChanges({ idField: 'uid' }) as any;
  }

  // class.service.ts
  async createClass(params: {
    courseId: string;
    title: string;
    instructorId: string;
    coverUrl: string;
    description: string;
  }) {
    const { courseId, title, instructorId, description } = params;
    const id = this.afs.createId();
    const now = firebase.firestore.FieldValue.serverTimestamp();

    // read course contentVersion (fallback 1)
    const courseRef = this.afs.doc(`courses/${courseId}`).ref;
    const courseSnap = await courseRef.get();
    const contentVersion =
      (courseSnap.exists && (courseSnap.data() as any)?.contentVersion) || 1;

    const cls: ClassSection = {
      id,
      courseId,
      contentVersion,
      instructorId,
      title: title.trim(),
      status: 'active',
      description: description,
      counts: { students: 0, instructors: 1 },
      createdAt: now,
      updatedAt: now,
      coverUrl: params.coverUrl,
    };

    const classRef = this.afs.doc(`classes/${id}`).ref;
    const memberRef = this.afs.doc(`classes/${id}/members/${instructorId}`).ref;
    const userIdxRef = this.afs.doc(
      `users/${instructorId}/classIndex/${id}`
    ).ref;

    const batch = this.afs.firestore.batch();
    batch.set(classRef, cls);
    batch.set(memberRef, {
      uid: instructorId,
      role: 'instructor',
      status: 'active',
      enrolledAt: now,
    });
    batch.set(userIdxRef, {
      classId: id,
      title: cls.title,
      role: 'instructor',
      status: 'active',
      updatedAt: now,
    });
    await batch.commit();

    return id;
  }

  async inviteByEmail(
    classId: string,
    email: string,
    role: Role = 'student'
  ): Promise<string> {
    const clean = email.trim();
    if (!clean) throw new Error('Email requis');

    const db = this.afs.firestore;

    let snap = await db
      .collection('users')
      .where('emailLower', '==', clean.toLowerCase())
      .limit(1)
      .get();

    if (snap.empty) {
      snap = await db
        .collection('users')
        .where('email', '==', clean)
        .limit(1)
        .get();
    }
    if (snap.empty) throw new Error('Utilisateur introuvable avec cet email.');

    const uid = snap.docs[0].id;
    await this.addOrUpdateMemberInTx(classId, uid, role);
    return uid;
  }
  // cancel a pending invite
  async cancelInvite(classId: string, inviteId: string) {
    await this.afs.doc(`classes/${classId}/invites/${inviteId}`).delete();
  }

  /** --- NEW: remove a single member (and fix counters + user index) --- */
  async removeMember(classId: string, uid: string) {
    const memRef = this.afs.doc(`classes/${classId}/members/${uid}`).ref;
    const memSnap = await memRef.get();
    if (!memSnap.exists) return;

    const role = (memSnap.data() as any)?.role as Role;
    const batch = this.afs.firestore.batch();
    batch.delete(memRef);
    const classRef = this.afs.doc(`classes/${classId}`).ref;
    const incField =
      role === 'student'
        ? { 'counts.students': firebase.firestore.FieldValue.increment(-1) }
        : { 'counts.instructors': firebase.firestore.FieldValue.increment(-1) };
    batch.update(classRef, {
      ...incField,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    // remove user index (best-effort)
    const userIdxRef = this.afs.doc(`users/${uid}/classIndex/${classId}`).ref;
    batch.delete(userIdxRef);
    await batch.commit();
  }

  /** --- NEW: delete class with members (client-side cascade) --- */
  async deleteClass(classId: string) {
    // delete members (in chunks <= 500)
    while (true) {
      const chunk = await this.afs
        .collection(`classes/${classId}/members`, (ref) => ref.limit(500))
        .ref.get();
      if (chunk.empty) break;
      const b = this.afs.firestore.batch();
      chunk.docs.forEach((d) => {
        b.delete(d.ref);
        const uid = d.id;
        b.delete(this.afs.doc(`users/${uid}/classIndex/${classId}`).ref);
      });
      await b.commit();
      if (chunk.size < 500) break;
    }

    // TODO: also delete assignments, announcements, etc. in a similar loop.

    await this.afs.doc(`classes/${classId}`).delete();
  }
  userClassIndex$(uid: string): Observable<UserClassIndex[]> {
    return this.afs
      .collection<UserClassIndex>(`users/${uid}/classIndex`, (ref) =>
        ref.orderBy('updatedAt', 'desc')
      )
      .valueChanges()
      .pipe(map((rows) => rows.map((r) => ({ ...r }))));
  }

  pendingInvites$(classId: string) {
    return this.afs
      .collection<PendingInvite>(`classes/${classId}/invites`, (ref) =>
        ref.orderBy('createdAt', 'desc')
      )
      .valueChanges({ idField: 'id' });
  }

  /** Existing behavior if user doc exists; otherwise create a pending invite doc. */
  // class.service.ts
  async inviteByEmailOrCreatePending(
    classId: string,
    email: string,
    role: Role = 'student',
    invitedByUid?: string
  ): Promise<string | null> {
    const clean = email.trim();
    if (!clean) throw new Error('Email requis');
    const lower = clean.toLowerCase();

    const db = this.afs.firestore;

    console.debug('[invite] classId', classId, 'email', clean);

    // Debug: prove filters are correct
    const byLower = await db
      .collection('users')
      .where('emailLower', '==', lower)
      .get();
    console.debug(
      '[invite] byLower.size',
      byLower.size,
      byLower.docs.map((d) => ({ id: d.id, ...d.data() }))
    );

    const byEmail = await db
      .collection('users')
      .where('email', '==', clean)
      .get();
    console.debug(
      '[invite] byEmail.size',
      byEmail.size,
      byEmail.docs.map((d) => ({ id: d.id, ...d.data() }))
    );

    // Actual lookup (filtered!)
    let snap = await db
      .collection('users')
      .where('emailLower', '==', lower)
      .limit(1)
      .get();

    if (snap.empty) {
      snap = await db
        .collection('users')
        .where('email', '==', clean)
        .limit(1)
        .get();
    }

    if (!snap.empty) {
      const uid = snap.docs[0].id;
      console.debug('[invite] existing user -> add member', uid);
      await this.addOrUpdateMemberInTx(classId, uid, role);

      // NEW: remove any pending invite for the same email
      const db = this.afs.firestore;
      const invSnap = await db
        .collection(`classes/${classId}/invites`)
        .where('email', '==', lower)
        .get();
      if (!invSnap.empty) {
        const batch = db.batch();
        invSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }

      return uid;
    }

    // No user yet → create pending invite
    console.debug('[invite] no user -> create pending invite for', lower);

    const now = firebase.firestore.FieldValue.serverTimestamp();
    const invitesCol = db.collection(`classes/${classId}/invites`);

    const existing = await invitesCol
      .where('email', '==', lower)
      .limit(1)
      .get();
    const docRef = existing.empty ? invitesCol.doc() : existing.docs[0].ref;

    await docRef.set(
      {
        email: lower,
        role,
        status: 'pending',
        createdAt: now,
        invitedBy: invitedByUid ?? '',
      },
      { merge: true }
    );

    await db.doc(`classes/${classId}`).update({ updatedAt: now });
    return null;
  }

  private async addOrUpdateMemberInTx(
    classId: string,
    uid: string,
    role: Role
  ) {
    const classRef = this.afs.doc(`classes/${classId}`).ref;
    const memberRef = this.afs.doc(`classes/${classId}/members/${uid}`).ref;
    const userIdxRef = this.afs.doc(`users/${uid}/classIndex/${classId}`).ref;

    await this.afs.firestore.runTransaction(async (tx) => {
      const [classDoc, memberDoc] = await Promise.all([
        tx.get(classRef),
        tx.get(memberRef),
      ]);
      if (!classDoc.exists) throw new Error('Classe introuvable');

      const classTitle = (classDoc.data() as any)?.title || '';
      const now = firebase.firestore.FieldValue.serverTimestamp();

      const prevRole = (
        memberDoc.exists ? (memberDoc.data() as any).role : null
      ) as Role | null;
      let newRole: Role = role;
      if (prevRole === 'instructor' && role !== 'instructor')
        newRole = 'instructor';

      const updates: any = { updatedAt: now };
      if (!memberDoc.exists) {
        const inc =
          newRole === 'student' ? 'counts.students' : 'counts.instructors';
        updates[inc] = firebase.firestore.FieldValue.increment(1);
      } else if (prevRole !== newRole) {
        const dec =
          prevRole === 'student' ? 'counts.students' : 'counts.instructors';
        const inc =
          newRole === 'student' ? 'counts.students' : 'counts.instructors';
        updates[dec] = firebase.firestore.FieldValue.increment(-1);
        updates[inc] = firebase.firestore.FieldValue.increment(1);
      }
      if (Object.keys(updates).length > 1) tx.update(classRef, updates);

      const enrolledAt = memberDoc.exists
        ? (memberDoc.data() as any).enrolledAt ?? now
        : now;

      tx.set(
        memberRef,
        { uid, role: newRole, status: 'active', enrolledAt },
        { merge: true }
      );
      tx.set(
        userIdxRef,
        {
          classId,
          title: classTitle,
          role: newRole,
          status: 'active',
          updatedAt: now,
        },
        { merge: true }
      );
    });
  }

  user$(uid: string) {
    return this.afs.doc<User>(`users/${uid}`).valueChanges({ idField: 'uid' });
  }

  membersWithUsers$(classId: string) {
    return this.afs
      .collection<ClassMember>(`classes/${classId}/members`, (ref) =>
        ref.orderBy('role')
      )
      .valueChanges({ idField: 'uid' })
      .pipe(
        switchMap((members) => {
          if (!members.length)
            return of(
              [] as (ClassMember & { uid: string; user: User | null })[]
            );
          const streams = members.map((m) => this.user$(m.uid));
          return combineLatest(streams).pipe(
            map((users) =>
              members.map((m, i) => ({ ...m, user: users[i] ?? null }))
            )
          );
        })
      );
  }

  /** All classes where uid is an active member */
  myClassesAsMember$(uid: string) {
    const members$ = this.afs
      .collectionGroup<ClassMember>('members', (ref) =>
        ref.where('uid', '==', uid).where('status', '==', 'active')
      )
      .snapshotChanges();

    return members$.pipe(
      switchMap((snaps) => {
        if (!snaps.length) return of<ClassSection[]>([]);
        const classStreams = snaps.map((s) => {
          const classRef = s.payload.doc.ref.parent.parent!; // classes/{classId}
          return this.afs
            .doc<ClassSection>(classRef.path)
            .valueChanges()
            .pipe(
              map((cl) =>
                cl ? ({ ...cl, id: classRef.id } as ClassSection) : null
              )
            );
        });
        return combineLatest(classStreams).pipe(
          map((arr) => arr.filter((x): x is ClassSection => !!x))
        );
      })
    );
  }
  /** Small list for navbar */
  navClasses$(uid: string, limitCount = 6) {
    const members$ = this.afs
      .collectionGroup<ClassMember>('members', (ref) =>
        ref
          .where('uid', '==', uid)
          .where('status', '==', 'active')
          .limit(limitCount)
      )
      .snapshotChanges();

    return members$.pipe(
      switchMap((snaps) => {
        if (!snaps.length)
          return of<{ id: string; title: string; coverUrl?: string }[]>([]);
        const classStreams = snaps.map((s) => {
          const classRef = s.payload.doc.ref.parent.parent!;
          return this.afs
            .doc<ClassSection>(classRef.path)
            .valueChanges()
            .pipe(
              map((cl) =>
                cl
                  ? { id: classRef.id, title: cl.title, coverUrl: cl.coverUrl }
                  : null
              )
            );
        });
        return combineLatest(classStreams).pipe(
          map((arr) => arr.filter(Boolean) as any[])
        );
      })
    );
  }

  /** Resolve a username to uid and add the user to the class immediately. */
  async addMemberByUsername(
    classId: string,
    rawUsername: string,
    role: Role
  ): Promise<string> {
    const username = (rawUsername || '').trim().toLowerCase();
    if (!username) throw new Error('Nom d’utilisateur requis.');

    // usernames/{username} -> { uid: string, authEmail: string }
    const unameSnap = await this.afs
      .doc<{ uid: string }>(`usernames/${username}`)
      .ref.get();
    if (!unameSnap.exists) {
      throw new Error(
        'Nom d’utilisateur introuvable. Créez d’abord le compte.'
      );
    }
    const { uid } = unameSnap.data()!;

    await this.addOrUpdateMemberInTx(classId, uid, role);
    return uid;
  }

  /** From earlier step: ensure we also maintain a users/{uid}/classes/{classId} index (optional but nice) */
  private async addMemberIfMissing(classId: string, uid: string, role: Role) {
    const mRef = this.afs.doc(`classes/${classId}/members/${uid}`);
    const mSnap = await mRef.ref.get();
    if (!mSnap.exists) {
      await mRef.set({
        uid,
        role,
        status: 'active',
        enrolledAt: serverTimestamp(),
      });
    } else {
      await mRef.set({ role, status: 'active' }, { merge: true });
    }

    // optional: write user-side index for fast dashboards
    const clSnap = await this.afs
      .doc<ClassSection>(`classes/${classId}`)
      .ref.get();
    const title = clSnap.exists ? (clSnap.data() as any).title : '';
    await this.afs.doc(`users/${uid}/classes/${classId}`).set(
      {
        classId,
        role,
        status: 'active',
        title,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
  // class.service.ts
  myClasses$(uid: string) {
    return this.afs
      .collection<any>(
        'classes',
        (ref) =>
          ref.where(`members.${uid}`, 'in', ['student', 'instructor', 'ta']) // or '!=', true depending on your schema
      )
      .valueChanges({ idField: 'id' });
  }
  updateClass(
    classId: string,
    patch: Partial<Pick<ClassSection, 'title' | 'description' | 'coverUrl'>>
  ) {
    return this.afs.doc(`classes/${classId}`).update({
      ...patch,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async transferMembers(opts: {
    sourceId: string;
    destId: string;
    mode: 'copy' | 'move';
    includeRoles?: ('student' | 'instructor' | 'ta')[];
  }): Promise<{ added: number; skipped: number; removedFromA?: number }> {
    const { sourceId, destId, mode, includeRoles } = opts;
    if (sourceId === destId)
      throw new Error('Source et destination identiques');

    const db = getFirestore();

    // Load A and B
    const [srcSnap, dstSnap] = await Promise.all([
      getDocs(collection(db, `classes/${sourceId}/members`)),
      getDocs(collection(db, `classes/${destId}/members`)),
    ]);

    const destUIDs = new Set(dstSnap.docs.map((d) => d.id));

    // Filter by role
    const srcMembers = srcSnap.docs
      .map((d) => ({ uid: d.id, ...(d.data() as any) }))
      .filter((m) => {
        if (!includeRoles || includeRoles.length === 0) return true;
        return includeRoles.includes((m.role || 'student') as any);
      });

    const toAdd = srcMembers.filter((m) => !destUIDs.has(m.uid));
    const skipped = srcMembers.length - toAdd.length;

    // --- Add to destination with required fields + user index ---
    const addBatch = writeBatch(db);
    for (const m of toAdd) {
      const role = (m.role || 'student') as Role;

      const memRef = doc(db, `classes/${destId}/members/${m.uid}`);
      addBatch.set(
        memRef,
        {
          uid: m.uid,
          role,
          status: 'active',
          enrolledAt: serverTimestamp(),
        },
        { merge: true }
      );

      const idxRef = doc(db, `users/${m.uid}/classIndex/${destId}`);
      addBatch.set(
        idxRef,
        {
          classId: destId,
          role,
          status: 'active',
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
    if (toAdd.length) await addBatch.commit();

    // --- If moving, remove from A using your existing helper to keep counters/index tidy ---
    let removedFromA = 0;
    if (mode === 'move') {
      for (const m of srcMembers) {
        await this.removeMember(sourceId, m.uid); // uses your counter + index cleanup
        removedFromA++;
      }
    }

    return {
      added: toAdd.length,
      skipped,
      ...(mode === 'move' ? { removedFromA } : {}),
    };
  }

  /**
   * Bulk remove members from a class (chunked for Firestore batch limits).
   * @returns number of removed documents
   */
  async bulkRemoveMembers(classId: string, uids: string[]): Promise<number> {
    const db = getFirestore();
    const CHUNK = 450;
    let removed = 0;

    for (let i = 0; i < uids.length; i += CHUNK) {
      const slice = uids.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      for (const uid of slice) {
        batch.delete(doc(db, `classes/${classId}/members/${uid}`));
        batch.delete(doc(db, `users/${uid}/classIndex/${classId}`)); // keep index clean
      }
      await batch.commit();
      removed += slice.length;
    }
    return removed;
  }

  async resolveUidByEmail(email: string): Promise<string | null> {
    const db = getFirestore();
    const usersCol = collection(db, 'users');
    // assuming you store a lowercase field for fast lookups
    const qy = query(usersCol, where('emailLower', '==', email.toLowerCase()));
    const snap = await getDocs(qy);
    if (snap.empty) return null;
    return snap.docs[0].id;
  }

  async resolveUidByUsername(username: string): Promise<string | null> {
    const db = getFirestore();
    const usersCol = collection(db, 'users');
    const qy = query(
      usersCol,
      where('usernameLower', '==', username.toLowerCase())
    );
    const snap = await getDocs(qy);
    if (snap.empty) return null;
    return snap.docs[0].id;
  }

  /**
   * Batch add members to a class. Skips existing members.
   * Returns number of newly added docs.
   */
  async bulkAddMembers(
    classId: string,
    items: { uid: string; role: Role }[]
  ): Promise<number> {
    if (!items.length) return 0;

    const db = getFirestore();

    // Build existing set
    const existingSnap = await getDocs(
      collection(db, `classes/${classId}/members`)
    );
    const existing = new Set(existingSnap.docs.map((d) => d.id));

    const CHUNK = 450;
    let added = 0;

    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      let writes = 0;

      for (const m of slice) {
        if (existing.has(m.uid)) continue;

        // --- FIX: write uid + status + enrolledAt (use your schema names) ---
        const memRef = doc(db, `classes/${classId}/members/${m.uid}`);
        batch.set(
          memRef,
          {
            uid: m.uid,
            role: m.role || 'student',
            status: 'active',
            enrolledAt: serverTimestamp(), // (you used enrolledAt elsewhere)
          },
          { merge: true }
        );

        // --- Recommended: keep user index in sync (matches your create/add paths) ---
        const idxRef = doc(db, `users/${m.uid}/classIndex/${classId}`);
        batch.set(
          idxRef,
          {
            classId,
            role: m.role || 'student',
            status: 'active',
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        existing.add(m.uid);
        added++;
        writes++;
      }

      if (writes > 0) await batch.commit();
    }

    return added;
  }

  // class.service.ts
}
