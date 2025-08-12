import { Component, OnInit } from '@angular/core';
import { Observable, of, firstValueFrom } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';
import { Course, User } from 'src/app/model/user';
import { AuthService } from 'src/app/shared/auth.service';
import { CourseService } from 'src/app/shared/course.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnInit {
  me$!: Observable<User | null>;
  myCourses$!: Observable<Course[]>;

  // Create/Edit dialog state
  showCourseDialog = false;
  editCourse: Course | null = null;
  courseForm = { title: '', description: '' };

  constructor(private auth: AuthService, private courses: CourseService) {}

  ngOnInit(): void {
    this.me$ = this.auth.user$;
    this.myCourses$ = this.auth.user$.pipe(
      switchMap((me) => (me?.uid ? this.courses.myCourses$(me.uid) : of([])))
    );
    console.log('My courses', this.myCourses$);
  }

  // UI helpers
  label(u: User | null): string {
    if (!u) return '';
    if ((u.firstName ?? '') || (u.lastName ?? '')) {
      return `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
    }
    return u.email ?? '';
  }
  initials(u: User | null): string {
    if (!u) return 'ME';
    const base =
      u.firstName || u.lastName
        ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
        : u.email ?? 'me';
    const parts = base.split(/[\s._-]+/).filter(Boolean);
    const a = (parts[0]?.[0] ?? 'M').toUpperCase();
    const b = (parts[1]?.[0] ?? u.email?.[0] ?? 'E').toUpperCase();
    return a + b;
  }
  friendlyName(u: User | null): string {
    if (!u) return 'collaborateur';
    const base =
      u.firstName || u.lastName
        ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
        : u.email ?? 'collaborateur';
    const cleaned = base.split('@')[0].replace(/[._-]+/g, ' ');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // --- Course dialog actions ---
  openCreateCourse() {
    this.editCourse = null;
    this.courseForm = { title: '', description: '' };
    this.showCourseDialog = true;
  }
  openEditCourse(c: Course) {
    this.editCourse = c;
    this.courseForm = { title: c.title, description: c.description ?? '' };
    this.showCourseDialog = true;
  }
  closeCourseDialog() {
    this.showCourseDialog = false;
  }
  async saveCourse() {
    const me = await firstValueFrom(this.auth.user$.pipe(take(1)));
    if (!me?.uid) return;

    if (this.editCourse) {
      await this.courses.update(this.editCourse.id!, {
        title: this.courseForm.title.trim(),
        description: this.courseForm.description.trim(),
      });
    } else {
      await this.courses.create({
        title: this.courseForm.title.trim(),
        description: this.courseForm.description.trim(),
        ownerId: me.uid,
      });
    }
    this.showCourseDialog = false;
  }
  deleteCourse(c: Course) {
    if (confirm('Supprimer ce cours ?')) {
      this.courses.delete(c.id!);
    }
  }
}
