import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { Student } from '../model/student';

@Injectable({
  providedIn: 'root',
})
export class DataService {
  constructor(private afs: AngularFirestore) {}
  public getGradientColor(value: number) {
    if (value < 50) {
      return 'rgb(255, 0, 0)'; // F: Red for values below 50
    } else if (value < 60) {
      return 'rgb(255, 87, 34)'; // E: Red-Orange for 50-60
    } else if (value < 70) {
      return 'rgb(255, 152, 0)'; // D: Orange for 60-70
    } else if (value < 80) {
      return 'rgb(255, 193, 7)'; // C: Yellow for 70-80
    } else if (value < 90) {
      return 'rgb(139, 195, 74)'; // B: Light Green for 80-90
    } else {
      return 'rgb(40, 167, 69)'; // A: Green for 90-100
    }
  }
}
