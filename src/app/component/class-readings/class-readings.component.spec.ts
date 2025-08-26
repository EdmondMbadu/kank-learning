import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ClassReadingsComponent } from './class-readings.component';

describe('ClassReadingsComponent', () => {
  let component: ClassReadingsComponent;
  let fixture: ComponentFixture<ClassReadingsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ ClassReadingsComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ClassReadingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
