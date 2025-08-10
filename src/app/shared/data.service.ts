import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { Student } from '../model/student';

@Injectable({
  providedIn: 'root',
})
export class DataService {
  constructor(private afs: AngularFirestore) {}

  addStudent(student: Student) {
    student.id = this.afs.createId();
    // return
    this.afs.collection('/Students').add(student);
  }

  getAllStudents() {
    return this.afs.collection('/Students').snapshotChanges(); // snapshot because we want the id as well
  }

  deleteStudent(student: Student) {
    return this.afs.doc('/Students/' + student.id).delete();
  }

  updateStudent(student: Student) {
    this.deleteStudent(student);
    this.addStudent(student);
  }
}
