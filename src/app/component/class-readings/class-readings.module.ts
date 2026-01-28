import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Routes } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ClassReadingsComponent } from './class-readings.component';
import { SharedModule } from '../../shared/shared.module';

const routes: Routes = [{ path: '', component: ClassReadingsComponent }];

@NgModule({
  declarations: [ClassReadingsComponent],
  imports: [CommonModule, FormsModule, SharedModule, RouterModule.forChild(routes)],
})
export class ClassReadingsModule {}
