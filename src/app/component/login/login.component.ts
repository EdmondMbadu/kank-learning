import { Component } from '@angular/core';
import { AuthService } from 'src/app/shared/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
})
export class LoginComponent {
  email = '';
  password = '';
  showPassword = false;
  loading = false;

  constructor(private auth: AuthService) {}

  async login() {
    if (!this.email || !this.password) {
      alert('Veuillez renseigner votre e-mail et votre mot de passe');
      return;
    }
    this.loading = true;
    try {
      await this.auth.login(this.email, this.password); // navigates to /home on success
      this.email = '';
      this.password = '';
    } catch {
      // error already alerted in service; keep fields as-is for retry
    } finally {
      this.loading = false;
    }
  }
}
