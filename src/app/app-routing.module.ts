import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './component/login/login.component';
import { RegisterComponent } from './component/register/register.component';
import { VerifyEmailComponent } from './component/verify-email/verify-email.component';
import { ForgotPasswordComponent } from './component/forgot-password/forgot-password.component';
import { LandingPageComponent } from './component/landing-page/landing-page.component';

const routes: Routes = [
  { path: '', component: LandingPageComponent },
  { path: 'login', component: LoginComponent },
  {
    path: 'dashboard',
    loadChildren: () =>
      import('./component/dashboard/dashboard.module').then(
        (m) => m.DashboardModule
      ),
  },
  { path: 'class/:id', loadChildren: () =>
      import('./component/class/class.module').then((m) => m.ClassModule) },

  { path: 'register', component: RegisterComponent },
  { path: 'verify-email', component: VerifyEmailComponent },
  { path: 'forgot-password', component: ForgotPasswordComponent },
  {
    path: 'profile',
    loadChildren: () =>
      import('./component/profile/profile.module').then(
        (m) => m.ProfileModule
      ),
  }, // e.g., /me
  {
    path: 'grades',
    loadChildren: () =>
      import('./component/grades/grades.module').then((m) => m.GradesModule),
  },
  {
    path: 'messages',
    loadChildren: () =>
      import('./component/messages/messages.module').then(
        (m) => m.MessagesModule
      ),
  },
  {
    path: 'class/:classId/quiz/:quizId',
    loadChildren: () =>
      import('./component/quiz-take/quiz-take.module').then(
        (m) => m.QuizTakeModule
      ),
  },
  {
    path: 'class/:id/readings',
    loadChildren: () =>
      import('./component/class-readings/class-readings.module').then(
        (m) => m.ClassReadingsModule
      ),
  },

  {
    path: 'activity',
    loadChildren: () =>
      import('./component/activity/activity.module').then(
        (m) => m.ActivityModule
      ),
  },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
