import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './component/login/login.component';
import { DashboardComponent } from './component/dashboard/dashboard.component';
import { RegisterComponent } from './component/register/register.component';
import { VerifyEmailComponent } from './component/verify-email/verify-email.component';
import { ForgotPasswordComponent } from './component/forgot-password/forgot-password.component';
import { LandingPageComponent } from './component/landing-page/landing-page.component';
import { AuthGuard } from './shared/auth.guard';
import { ClassComponent } from './component/class/class.component';
import { ProfileComponent } from './component/profile/profile.component';
import { GradesComponent } from './component/grades/grades.component';
import { MessagesComponent } from './component/messages/messages.component';
import { QuizTakeComponent } from './component/quiz-take/quiz-take.component';
import { ActivityComponent } from './component/activity/activity.component';

const routes: Routes = [
  { path: '', component: LandingPageComponent },
  { path: 'login', component: LoginComponent },
  {
    path: 'dashboard',
    component: DashboardComponent,
    canActivate: [AuthGuard],
  },
  // app-routing.module.ts
  { path: 'class/:id', component: ClassComponent, canActivate: [AuthGuard] },

  { path: 'register', component: RegisterComponent },
  { path: 'verify-email', component: VerifyEmailComponent },
  { path: 'forgot-password', component: ForgotPasswordComponent },
  // app-routing.module.ts
  { path: 'profile', component: ProfileComponent, canActivate: [AuthGuard] }, // e.g., /me
  { path: 'grades', component: GradesComponent, canActivate: [AuthGuard] },
  { path: 'messages', component: MessagesComponent, canActivate: [AuthGuard] },
  {
    path: 'class/:classId/quiz/:quizId',
    component: QuizTakeComponent,
    canActivate: [AuthGuard],
  },
  { path: 'activity', component: ActivityComponent, canActivate: [AuthGuard] },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
