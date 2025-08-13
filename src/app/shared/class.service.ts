// src/app/shared/class.service.ts
import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
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
  }) {
    const { courseId, title, instructorId } = params;
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
      counts: { students: 0, instructors: 1 },
      createdAt: now,
      updatedAt: now,
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

  myClassesAsMember$(uid: string) {
    return this.userClassIndex$(uid).pipe(
      switchMap((rows) => {
        if (!rows.length) return of([] as Array<ClassSection & { role: Role }>);
        const streams = rows.map((r) => this.class$(r.classId));
        return combineLatest(streams).pipe(
          map((classes) =>
            classes
              .filter((c): c is ClassSection => !!c)
              .map((c, i) => ({ ...c, role: rows[i].role }))
          )
        );
      })
    );
  }

  // class.service.ts
}
