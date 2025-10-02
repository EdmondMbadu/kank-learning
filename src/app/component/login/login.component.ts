import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from 'src/app/shared/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
})
export class LoginComponent implements OnInit {
  // login.component.ts
  mode: 'username' | 'email' = 'username'; // default = student (username) login

  username = '';
  email = '';
  password = '';
  showPassword = false;
  loading = false;
  error = '';

  constructor(private auth: AuthService, private route: ActivatedRoute) {}

  ngOnInit() {
    window.scroll(0, 0);
    const q = this.route.snapshot.queryParamMap.get('returnUrl');
    if (q && q.startsWith('/')) {
      localStorage.setItem('auth:redirect', q);
    }
  }
  async login() {
    this.error = '';
    if (this.loading) return;

    const id =
      this.mode === 'username' ? this.username?.trim() : this.email?.trim();
    if (!id || !this.password) return;

    this.loading = true;
    try {
      if (this.mode === 'username') {
        // Replace with your real method for username-based auth:
        await this.auth.loginWithUsername(id, this.password);
      } else {
        // Replace with your real method for email-based auth:
        await this.auth.login(id.toLowerCase(), this.password);
      }
      // navigate if needed
      // this.router.navigateByUrl('/dashboard');
    } catch (e: any) {
      this.error = e?.message || 'Impossible de se connecter.';
    } finally {
      this.loading = false;
    }
  }
}
