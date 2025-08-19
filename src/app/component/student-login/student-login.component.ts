import { Component } from '@angular/core';
import { AuthService } from 'src/app/shared/auth.service';

@Component({
  selector: 'app-student-login',
  templateUrl: './student-login.component.html',
})
export class StudentLoginComponent {
  username = '';
  code = '';
  showCode = false;
  loading = false;
  err = '';

  constructor(private auth: AuthService) {}

  async login() {
    if (!this.username || !this.code) {
      this.err = 'Veuillez renseigner votre nom d’utilisateur et votre code.';
      return;
    }
    this.err = '';
    this.loading = true;
    try {
      await this.auth.loginWithUsername(this.username, this.code);
      // success → AuthService handles navigation
      this.username = '';
      this.code = '';
    } catch (e: any) {
      this.err = e?.message || 'Échec de connexion.';
    } finally {
      this.loading = false;
    }
  }
}
