// src/app/shared/class.service.ts
import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { of } from 'rxjs';
import { map } from 'rxjs';
import { Observable } from 'rxjs';
import {
  ClassSection,
  ClassMember,
  Role,
  UserClassIndex,
} from 'src/app/model/user';

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

  async createClass(params: {
    courseId: string;
    title: string;
    instructorId: string;
  }) {
    const { courseId, title, instructorId } = params;
    const id = this.afs.createId();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const courseSnap = await this.afs.doc(`courses/${courseId}`).ref.get();
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

    await this.afs.doc(`classes/${id}`).set(cls);
    await this.afs.doc(`classes/${id}/members/${instructorId}`).set({
      uid: instructorId,
      role: 'instructor',
      status: 'active',
      enrolledAt: now,
    });
    await this.afs.doc(`users/${instructorId}/classIndex/${id}`).set({
      classId: id,
      role: 'instructor',
      status: 'active',
      title: cls.title,
      updatedAt: now,
    });
    return id;
  }

  /** --- NEW: invite by email (unchanged from earlier) --- */
  async inviteByEmail(classId: string, email: string, role: Role = 'student') {
    const clean = email.trim();
    if (!clean) throw new Error('Email requis');

    let q = this.afs.collection('users', (ref) =>
      ref.where('emailLower', '==', clean.toLowerCase())
    ).ref;
    let snap = await q.get();
    if (snap.empty) {
      q = this.afs.collection('users', (ref) =>
        ref.where('email', '==', clean)
      ).ref;
      snap = await q.get();
    }
    if (snap.empty) throw new Error('Utilisateur introuvable avec cet email.');

    const userDoc = snap.docs[0];
    const uid = userDoc.id;
    const now = firebase.firestore.FieldValue.serverTimestamp();

    await this.afs.doc(`classes/${classId}/members/${uid}`).set(
      {
        uid,
        role,
        status: 'active',
        enrolledAt: now,
      },
      { merge: true }
    );

    const incField =
      role === 'student'
        ? { 'counts.students': firebase.firestore.FieldValue.increment(1) }
        : { 'counts.instructors': firebase.firestore.FieldValue.increment(1) };
    await this.afs
      .doc(`classes/${classId}`)
      .update({ ...incField, updatedAt: now });

    const classSnap = await this.afs.doc(`classes/${classId}`).ref.get();
    const title = (classSnap.data() as any)?.title || '';
    await this.afs.doc(`users/${uid}/classIndex/${classId}`).set(
      {
        classId,
        role,
        status: 'active',
        title,
        updatedAt: now,
      },
      { merge: true }
    );
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
}
