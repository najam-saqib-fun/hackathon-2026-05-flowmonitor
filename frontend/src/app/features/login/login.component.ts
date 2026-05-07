import { Component, inject, signal } from '@angular/core';
import { FormBuilder, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { NgIf } from '@angular/common';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    ReactiveFormsModule, MatCardModule, MatFormFieldModule,
    MatInputModule, MatButtonModule, MatIconModule,
    MatProgressSpinnerModule, NgIf,
  ],
  template: `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1117;">
      <mat-card style="width:380px;background:#1a1d27;border:1px solid #2d3148;border-radius:16px;padding:2rem;">
        <div style="text-align:center;margin-bottom:2rem;">
          <div style="font-size:2rem;color:#818cf8;margin-bottom:0.5rem;">◈ FlowMon</div>
          <div style="color:#64748b;font-size:0.9rem;">ISP Traffic Analytics Platform</div>
        </div>

        <form [formGroup]="form" (ngSubmit)="login()">
          <mat-form-field appearance="outline" style="width:100%;margin-bottom:1rem;">
            <mat-label>Username</mat-label>
            <input matInput formControlName="username" autocomplete="username">
            <mat-icon matPrefix>person</mat-icon>
          </mat-form-field>

          <mat-form-field appearance="outline" style="width:100%;margin-bottom:1.5rem;">
            <mat-label>Password</mat-label>
            <input matInput [type]="showPass() ? 'text' : 'password'" formControlName="password" autocomplete="current-password">
            <mat-icon matPrefix>lock</mat-icon>
            <button mat-icon-button matSuffix type="button" (click)="showPass.set(!showPass())">
              <mat-icon>{{ showPass() ? 'visibility_off' : 'visibility' }}</mat-icon>
            </button>
          </mat-form-field>

          <div *ngIf="error()" style="color:#f87171;font-size:0.85rem;margin-bottom:1rem;text-align:center;">
            {{ error() }}
          </div>

          <button mat-flat-button color="primary" type="submit"
                  [disabled]="form.invalid || loading()"
                  style="width:100%;height:44px;font-size:1rem;">
            <mat-spinner *ngIf="loading()" diameter="20" style="margin:auto;"></mat-spinner>
            <span *ngIf="!loading()">Sign In</span>
          </button>
        </form>

        <div style="text-align:center;margin-top:1.5rem;color:#475569;font-size:0.75rem;">
          Default: admin / admin123
        </div>
      </mat-card>
    </div>
  `,
})
export class LoginComponent {
  private auth   = inject(AuthService);
  private router = inject(Router);
  private fb     = inject(FormBuilder);

  form    = this.fb.nonNullable.group({
    username: ['', Validators.required],
    password: ['', Validators.required],
  });
  loading = signal(false);
  error   = signal('');
  showPass = signal(false);

  login() {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');
    const { username, password } = this.form.getRawValue();
    this.auth.login(username, password).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: (err) => {
        this.error.set(err.error?.error || 'Login failed');
        this.loading.set(false);
      },
    });
  }
}
