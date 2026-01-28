import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Routes } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MessagesComponent } from './messages.component';
import { AuthGuard } from '../../shared/auth.guard';
import { SharedModule } from '../../shared/shared.module';

const routes: Routes = [
  { path: '', component: MessagesComponent, canActivate: [AuthGuard] },
];

@NgModule({
  declarations: [MessagesComponent],
  imports: [CommonModule, FormsModule, SharedModule, RouterModule.forChild(routes)],
})
export class MessagesModule {}
