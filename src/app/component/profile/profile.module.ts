import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Routes } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ProfileComponent } from './profile.component';
import { AuthGuard } from '../../shared/auth.guard';
import { SharedModule } from '../../shared/shared.module';

const routes: Routes = [
  { path: '', component: ProfileComponent, canActivate: [AuthGuard] },
];

@NgModule({
  declarations: [ProfileComponent],
  imports: [CommonModule, FormsModule, SharedModule, RouterModule.forChild(routes)],
})
export class ProfileModule {}
