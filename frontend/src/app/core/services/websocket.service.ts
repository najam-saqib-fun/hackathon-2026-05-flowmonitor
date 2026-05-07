import { Injectable, inject, OnDestroy, signal } from '@angular/core';
import { Subject, BehaviorSubject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private auth = inject(AuthService);
  private ws: WebSocket | null = null;

  private _connected$ = new BehaviorSubject<boolean>(false);
  private _message$   = new Subject<any>();
  private _alert$     = new Subject<any>();

  // Pause/Resume — socket stays open, UI updates frozen
  paused = signal(false);

  connected$ = this._connected$.asObservable();
  message$   = this._message$.asObservable();
  alert$     = this._alert$.asObservable();

  get isPaused() { return this.paused(); }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const token = this.auth.getToken();
    if (!token) return;

    this.ws = new WebSocket(`${environment.wsUrl}?token=${token}`);

    this.ws.onopen = () => {
      this._connected$.next(true);
      this.ws?.send(JSON.stringify({ type: 'subscribe' }));
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'alert') {
          // Alerts always get through regardless of pause state
          this._alert$.next(data);
        } else if (!this.paused()) {
          this._message$.next(data);
        }
      } catch {}
    };

    this.ws.onclose = () => {
      this._connected$.next(false);
      setTimeout(() => this.connect(), 5000);
    };

    this.ws.onerror = () => this.ws?.close();
  }

  pause() {
    this.paused.set(true);
  }

  resume() {
    this.paused.set(false);
    // Immediately re-subscribe to get fresh data
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe' }));
    }
  }

  toggle() {
    if (this.paused()) this.resume();
    else this.pause();
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }

  ngOnDestroy() {
    this.disconnect();
  }
}
