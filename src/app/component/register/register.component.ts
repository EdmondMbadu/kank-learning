import { Component } from '@angular/core';
import { AuthService } from 'src/app/shared/auth.service';

@Component({
  selector: 'app-register',
  templateUrl: './register.component.html',
  // no CSS file needed — all Tailwind classes inline
})
export class RegisterComponent {
  firstName = '';
  lastName = '';
  email = '';
  password = '';
  showPassword = false;
  loading = false;

  constructor(private auth: AuthService) {}

  async register() {
    if (!this.firstName || !this.lastName || !this.email || !this.password) {
      alert('Please fill in all fields');
      return;
    }
    this.loading = true;
    try {
      await this.auth.register(
        this.email,
        this.password,
        this.firstName,
        this.lastName
      );
      this.firstName = this.lastName = this.email = this.password = '';
    } finally {
      this.loading = false;
    }
  }
}
