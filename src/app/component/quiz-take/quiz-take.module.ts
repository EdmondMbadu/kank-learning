import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Routes } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { QuizTakeComponent } from './quiz-take.component';
import { AuthGuard } from '../../shared/auth.guard';
import { SharedModule } from '../../shared/shared.module';

const routes: Routes = [
  { path: '', component: QuizTakeComponent, canActivate: [AuthGuard] },
];

@NgModule({
  declarations: [QuizTakeComponent],
  imports: [CommonModule, FormsModule, SharedModule, RouterModule.forChild(routes)],
})
export class QuizTakeModule {}
