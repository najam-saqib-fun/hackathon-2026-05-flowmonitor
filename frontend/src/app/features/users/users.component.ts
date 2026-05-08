import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';

// ── Role definitions ─────────────────────────────────────────────────────────
const ROLES = [
  {
    value: 'admin',
    label: 'Admin',
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.15)',
    description: 'Full access — users, config, all data',
    permissions: ['Manage users', 'Manage roles', 'Edit mappings', 'Edit subscribers', 'Edit alerts', 'Edit policy', 'View all data'],
  },
  {
    value: 'operator',
    label: 'Operator',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.15)',
    description: 'Manage data — cannot manage users',
    permissions: ['Edit mappings', 'Edit subscribers', 'Edit alerts', 'Edit policy', 'View all data'],
  },
  {
    value: 'viewer',
    label: 'Viewer',
    color: '#22d3ee',
    bg: 'rgba(34,211,238,0.15)',
    description: 'Read-only access to all dashboards',
    permissions: ['View all data'],
  },
];

// ── User form dialog ──────────────────────────────────────────────────────────
import { Component as Comp, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

@Comp({
  selector: 'app-user-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatButtonModule, MatDialogModule, MatIconModule],
  template: `
    <h2 mat-dialog-title style="color:#e2e8f0;">{{ data.user ? 'Edit User' : 'Add User' }}</h2>
    <mat-dialog-content style="min-width:380px;padding-top:8px;">
      <form [formGroup]="form" style="display:flex;flex-direction:column;gap:1rem;">

        <mat-form-field appearance="outline">
          <mat-label>Username</mat-label>
          <input matInput formControlName="username" autocomplete="off">
          <mat-error *ngIf="form.get('username')?.hasError('required')">Required</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>{{ data.user ? 'New Password (leave blank to keep)' : 'Password' }}</mat-label>
          <input matInput type="password" formControlName="password" autocomplete="new-password">
          <mat-error *ngIf="form.get('password')?.hasError('required')">Required</mat-error>
          <mat-error *ngIf="form.get('password')?.hasError('minlength')">Min 6 characters</mat-error>
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Role</mat-label>
          <mat-select formControlName="role">
            <mat-option *ngFor="let r of roles" [value]="r.value">
              <span style="font-weight:500;">{{ r.label }}</span>
              <span style="color:#94a3b8;font-size:0.8rem;margin-left:8px;">— {{ r.description }}</span>
            </mat-option>
          </mat-select>
        </mat-form-field>

        <!-- Role permissions preview -->
        <div *ngIf="selectedRole" style="background:#1e293b;border-radius:8px;padding:0.75rem 1rem;">
          <div style="font-size:0.78rem;color:#94a3b8;margin-bottom:0.5rem;">Permissions</div>
          <div *ngFor="let p of selectedRole.permissions" style="font-size:0.82rem;color:#e2e8f0;margin-bottom:2px;">
            <mat-icon style="font-size:14px;width:14px;height:14px;vertical-align:middle;color:#22d3ee;margin-right:4px;">check_circle</mat-icon>
            {{ p }}
          </div>
        </div>

      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end" style="gap:8px;padding:1rem;">
      <button mat-stroked-button (click)="ref.close()">Cancel</button>
      <button mat-flat-button color="primary" [disabled]="form.invalid" (click)="submit()">
        {{ data.user ? 'Save Changes' : 'Create User' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class UserDialogComponent implements OnInit {
  roles = ROLES;
  form = inject(FormBuilder).group({
    username: ['', Validators.required],
    password: ['', [Validators.minLength(6)]],
    role:     ['viewer', Validators.required],
  });

  constructor(
    public ref: MatDialogRef<UserDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: { user?: any }
  ) {}

  ngOnInit() {
    if (this.data.user) {
      this.form.patchValue({ username: this.data.user.username, role: this.data.user.role });
    } else {
      this.form.get('password')!.addValidators(Validators.required);
      this.form.get('password')!.updateValueAndValidity();
    }
  }

  get selectedRole() { return ROLES.find(r => r.value === this.form.value.role); }

  submit() {
    if (this.form.invalid) return;
    const v = this.form.value;
    const out: any = { username: v.username, role: v.role };
    if (v.password) out.password = v.password;
    this.ref.close(out);
  }
}

// ── Delete confirm dialog ─────────────────────────────────────────────────────
@Comp({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title style="color:#e2e8f0;">Delete User</h2>
    <mat-dialog-content>
      <p style="color:#94a3b8;">Delete <strong style="color:#e2e8f0;">{{ data.username }}</strong>? This cannot be undone.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end" style="gap:8px;padding:1rem;">
      <button mat-stroked-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="warn" [mat-dialog-close]="true">Delete</button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDeleteDialogComponent {
  constructor(@Inject(MAT_DIALOG_DATA) public data: { username: string }) {}
}

// ── Main component ────────────────────────────────────────────────────────────
@Component({
  selector: 'app-users',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatDialogModule, MatChipsModule, MatTooltipModule,
    MatSnackBarModule, MatFormFieldModule, MatInputModule,
  ],
  template: `
    <div style="max-width:1100px;margin:0 auto;">

      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem;">
        <div>
          <h1 style="margin:0;font-size:1.5rem;font-weight:700;color:#e2e8f0;">User Management</h1>
          <p style="margin:0.25rem 0 0;color:#64748b;font-size:0.88rem;">Manage system users and their roles</p>
        </div>
        <button mat-flat-button color="primary" (click)="openAdd()">
          <mat-icon>person_add</mat-icon> Add User
        </button>
      </div>

      <!-- Role legend cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-bottom:1.5rem;">
        <div *ngFor="let r of roles" style="background:#1e293b;border-radius:12px;padding:1rem 1.25rem;border:1px solid #334155;">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
            <span [style.background]="r.bg" [style.color]="r.color"
                  style="padding:2px 10px;border-radius:99px;font-size:0.78rem;font-weight:600;">{{ r.label }}</span>
            <span style="color:#64748b;font-size:0.75rem;">{{ userCount(r.value) }} user{{ userCount(r.value) !== 1 ? 's' : '' }}</span>
          </div>
          <div style="font-size:0.82rem;color:#94a3b8;margin-bottom:0.5rem;">{{ r.description }}</div>
          <div *ngFor="let p of r.permissions" style="font-size:0.78rem;color:#64748b;">
            <mat-icon style="font-size:12px;width:12px;height:12px;vertical-align:middle;margin-right:3px;color:#22d3ee;">check</mat-icon>
            {{ p }}
          </div>
        </div>
      </div>

      <!-- Filters -->
      <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
        <input
          [(ngModel)]="search"
          placeholder="Search users…"
          style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:0.5rem 0.75rem;color:#e2e8f0;font-size:0.875rem;width:220px;outline:none;">
        <div style="display:flex;gap:0.5rem;">
          <button *ngFor="let r of filterOptions"
            (click)="roleFilter = r.value"
            [style.background]="roleFilter === r.value ? r.bg : 'transparent'"
            [style.color]="roleFilter === r.value ? r.color : '#64748b'"
            [style.border-color]="roleFilter === r.value ? r.color : '#334155'"
            style="border:1px solid;border-radius:99px;padding:3px 12px;font-size:0.78rem;cursor:pointer;font-weight:500;">
            {{ r.label }}
          </button>
        </div>
        <span style="color:#64748b;font-size:0.82rem;margin-left:auto;">{{ filteredUsers().length }} user{{ filteredUsers().length !== 1 ? 's' : '' }}</span>
      </div>

      <!-- Table -->
      <div style="background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155;">
        <table mat-table [dataSource]="filteredUsers()" style="width:100%;background:transparent;">

          <ng-container matColumnDef="username">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;font-size:0.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;">Username</th>
            <td mat-cell *matCellDef="let u" style="color:#e2e8f0;font-weight:500;">
              <div style="display:flex;align-items:center;gap:0.5rem;">
                <div [style.background]="getRole(u.role)?.bg ?? '#1e293b'"
                     style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;"
                     [style.color]="getRole(u.role)?.color ?? '#94a3b8'">
                  {{ u.username[0].toUpperCase() }}
                </div>
                <div>
                  <div>{{ u.username }}</div>
                  <div *ngIf="u.username === currentUser?.username" style="font-size:0.7rem;color:#818cf8;">(you)</div>
                </div>
              </div>
            </td>
          </ng-container>

          <ng-container matColumnDef="role">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;font-size:0.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;">Role</th>
            <td mat-cell *matCellDef="let u">
              <span [style.background]="getRole(u.role)?.bg ?? 'transparent'"
                    [style.color]="getRole(u.role)?.color ?? '#94a3b8'"
                    style="padding:2px 10px;border-radius:99px;font-size:0.78rem;font-weight:600;">
                {{ getRole(u.role)?.label ?? u.role }}
              </span>
            </td>
          </ng-container>

          <ng-container matColumnDef="created_at">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;font-size:0.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;">Created</th>
            <td mat-cell *matCellDef="let u" style="color:#94a3b8;font-size:0.82rem;">{{ fmt(u.created_at) }}</td>
          </ng-container>

          <ng-container matColumnDef="last_login">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;font-size:0.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;">Last Login</th>
            <td mat-cell *matCellDef="let u" style="color:#94a3b8;font-size:0.82rem;">{{ u.last_login ? fmt(u.last_login) : 'Never' }}</td>
          </ng-container>

          <ng-container matColumnDef="actions">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;font-size:0.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;text-align:right;">Actions</th>
            <td mat-cell *matCellDef="let u" style="text-align:right;">
              <button mat-icon-button (click)="openEdit(u)" matTooltip="Edit user">
                <mat-icon style="color:#94a3b8;">edit</mat-icon>
              </button>
              <button mat-icon-button (click)="confirmDelete(u)"
                      [disabled]="u.username === currentUser?.username"
                      [matTooltip]="u.username === currentUser?.username ? 'Cannot delete yourself' : 'Delete user'">
                <mat-icon [style.color]="u.username === currentUser?.username ? '#334155' : '#ef4444'">delete</mat-icon>
              </button>
            </td>
          </ng-container>

          <tr mat-header-row *matHeaderRowDef="cols" style="background:#0f172a;"></tr>
          <tr mat-row *matRowDef="let row; columns: cols;"
              style="border-bottom:1px solid #1e293b;transition:background 0.15s;"
              (mouseenter)="hoveredId=row.id" (mouseleave)="hoveredId=null"
              [style.background]="hoveredId === row.id ? '#243044' : 'transparent'"></tr>
        </table>

        <div *ngIf="!filteredUsers().length" style="text-align:center;padding:3rem;color:#475569;">
          No users match the current filter.
        </div>
      </div>

    </div>
  `,
})
export class UsersComponent implements OnInit {
  private api    = inject(ApiService);
  private dialog = inject(MatDialog);
  private snack  = inject(MatSnackBar);
  private auth   = inject(AuthService);

  roles = ROLES;
  users = signal<any[]>([]);
  search    = '';
  roleFilter: string | null = null;
  hoveredId: number | null = null;
  cols = ['username', 'role', 'created_at', 'last_login', 'actions'];

  filterOptions = [
    { value: null, label: 'All', color: '#818cf8', bg: 'rgba(99,102,241,0.15)' },
    ...ROLES.map(r => ({ value: r.value, label: r.label, color: r.color, bg: r.bg })),
  ];

  get currentUser() { return this.auth.currentUser; }

  ngOnInit() { this.load(); }

  load() {
    this.api.getUsers().subscribe({
      next: u => this.users.set(u),
      error: () => this.toast('Failed to load users', true),
    });
  }

  filteredUsers() {
    return this.users().filter(u => {
      const matchSearch = !this.search ||
        u.username.toLowerCase().includes(this.search.toLowerCase());
      const matchRole = !this.roleFilter || u.role === this.roleFilter;
      return matchSearch && matchRole;
    });
  }

  userCount(role: string) { return this.users().filter(u => u.role === role).length; }
  getRole(v: string) { return ROLES.find(r => r.value === v); }
  fmt(d: string) {
    return d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  openAdd() {
    this.dialog.open(UserDialogComponent, { data: {}, panelClass: 'dark-dialog' })
      .afterClosed().subscribe(result => {
        if (!result) return;
        this.api.createUser(result).subscribe({
          next: () => { this.toast('User created'); this.load(); },
          error: e => this.toast(e.error?.error || 'Failed to create user', true),
        });
      });
  }

  openEdit(user: any) {
    this.dialog.open(UserDialogComponent, { data: { user }, panelClass: 'dark-dialog' })
      .afterClosed().subscribe(result => {
        if (!result) return;
        this.api.updateUser(user.id, result).subscribe({
          next: () => { this.toast('User updated'); this.load(); },
          error: e => this.toast(e.error?.error || 'Failed to update user', true),
        });
      });
  }

  confirmDelete(user: any) {
    this.dialog.open(ConfirmDeleteDialogComponent, { data: { username: user.username }, panelClass: 'dark-dialog' })
      .afterClosed().subscribe(ok => {
        if (!ok) return;
        this.api.deleteUser(user.id).subscribe({
          next: () => { this.toast('User deleted'); this.load(); },
          error: e => this.toast(e.error?.error || 'Failed to delete user', true),
        });
      });
  }

  private toast(msg: string, err = false) {
    this.snack.open(msg, 'OK', {
      duration: 3500,
      panelClass: err ? ['snack-error'] : ['snack-ok'],
    });
  }
}
