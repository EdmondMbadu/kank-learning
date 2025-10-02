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
  private returnUrl?: string; // ⬅️ keep it in the component

  constructor(private auth: AuthService, private route: ActivatedRoute) {}

  ngOnInit() {
    window.scroll(0, 0);
    const q = this.route.snapshot.queryParamMap.get('returnUrl');
    if (q && q.startsWith('/')) {
      this.returnUrl = q; // ⬅️ capture for guaranteed handoff
      // (Optional fallbacks — keep them, they don’t hurt)
      try {
        sessionStorage.setItem('auth:redirect', q);
      } catch {}
      try {
        localStorage.setItem('auth:redirect', q);
      } catch {}
    }
  }
  async login() {
    this.error = '';
    if (this.loading) return;

    const id = (this.mode === 'username' ? this.username : this.email)?.trim();
    if (!id || !this.password) return;

    this.loading = true;
    try {
      if (this.mode === 'username') {
        await this.auth.loginWithUsername(id, this.password, this.returnUrl); // ⬅️ pass it
      } else {
        await this.auth.login(id.toLowerCase(), this.password, this.returnUrl); // ⬅️ pass it
      }
    } catch (e: any) {
      this.error = e?.message || 'Impossible de se connecter.';
    } finally {
      this.loading = false;
    }
  }
}
