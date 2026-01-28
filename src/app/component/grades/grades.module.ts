import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Routes } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { GradesComponent } from './grades.component';
import { AuthGuard } from '../../shared/auth.guard';
import { SharedModule } from '../../shared/shared.module';

const routes: Routes = [
  { path: '', component: GradesComponent, canActivate: [AuthGuard] },
];

@NgModule({
  declarations: [GradesComponent],
  imports: [CommonModule, FormsModule, SharedModule, RouterModule.forChild(routes)],
})
export class GradesModule {}
