// src/app/services/course.service.ts
import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { Observable } from 'rxjs';
import { Course, CourseDoc, CourseModule } from '../model/user';

@Injectable({ providedIn: 'root' })
export class CourseService {
  constructor(private afs: AngularFirestore) {}

  create(data: { title: string; description?: string; ownerId: string }) {
    const id = this.afs.createId();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const course: Course = {
      id,
      title: data.title.trim(),
      description: (data.description ?? '').trim(),
      ownerId: data.ownerId,
      published: false,
      contentVersion: 1,
      modulesCount: 0,
      lessonsCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return this.afs.doc(`courses/${id}`).set(course);
  }

  get$(id: string): Observable<CourseDoc | undefined> {
    return this.afs
      .doc<CourseDoc>(`courses/${id}`)
      .valueChanges({ idField: 'id' });
  }

  modules$(courseId: string): Observable<CourseModule[]> {
    return this.afs
      .collection<CourseModule>(`courses/${courseId}/modules`, (ref) =>
        ref.orderBy('order')
      )
      .valueChanges({ idField: 'id' });
  }
  myCourses$(uid: string): Observable<Course[]> {
    return this.afs
      .collection<Course>('courses', (ref) =>
        ref.where('ownerId', '==', uid).orderBy('createdAt', 'desc')
      )
      .valueChanges({ idField: 'id' });
  }

  update(id: string, patch: Partial<Course>) {
    return this.afs.doc<Course>(`courses/${id}`).update({
      ...patch,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  delete(id: string) {
    return this.afs.doc<Course>(`courses/${id}`).delete();
  }
}
