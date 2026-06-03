import { api } from './api';
import { User, useAuthStore } from '@/store/authStore';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  name: string;
}

export interface AuthResponse {
  user: User;
  /** Cognito ID token — what we send in Authorization. Carries the household
   *  custom claims that the backend's requireHousehold middleware checks. */
  idToken: string;
  /** Cognito access token — only for Cognito-direct endpoints (changePassword,
   *  updateProfile) which Cognito SDK rejects ID tokens for. */
  accessToken: string;
  refreshToken: string;
}

export interface ConfirmEmailData {
  email: string;
  code: string;
}

export interface ForgotPasswordData {
  email: string;
}

export interface ResetPasswordData {
  email: string;
  code: string;
  newPassword: string;
}

export const authService = {
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const response = await api.post<AuthResponse>('/auth/login', credentials);
    return response.data;
  },

  async register(data: RegisterData): Promise<{ message: string }> {
    const response = await api.post<{ message: string }>('/auth/signup', data);
    return response.data;
  },

  async confirmEmail(data: ConfirmEmailData): Promise<AuthResponse> {
    const response = await api.post<AuthResponse>('/auth/confirm', data);
    return response.data;
  },

  async resendConfirmationCode(email: string): Promise<{ message: string }> {
    const response = await api.post<{ message: string }>('/auth/resend-code', { email });
    return response.data;
  },

  async forgotPassword(data: ForgotPasswordData): Promise<{ message: string }> {
    const response = await api.post<{ message: string }>('/auth/forgot-password', data);
    return response.data;
  },

  async resetPassword(data: ResetPasswordData): Promise<{ message: string }> {
    const response = await api.post<{ message: string }>('/auth/reset-password', data);
    return response.data;
  },

  async refreshToken(
    refreshToken: string
  ): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
    const response = await api.post<{
      idToken: string;
      accessToken: string;
      refreshToken: string;
    }>('/auth/refresh', { refreshToken });
    return response.data;
  },

  async getCurrentUser(): Promise<User> {
    const response = await api.get<User>('/auth/me');
    return response.data;
  },

  async changePassword(data: { oldPassword: string; newPassword: string }): Promise<void> {
    const accessToken = useAuthStore.getState().accessToken;
    await api.post('/auth/change-password', data, {
      headers: accessToken ? { 'X-Cognito-Access-Token': accessToken } : {},
    });
  },

  async updateProfile(data: {
    name: string;
  }): Promise<{ id: string; email: string; name: string }> {
    const accessToken = useAuthStore.getState().accessToken;
    const response = await api.patch<{ id: string; email: string; name: string }>(
      '/auth/me',
      data,
      {
        headers: accessToken ? { 'X-Cognito-Access-Token': accessToken } : {},
      }
    );
    return response.data;
  },

  /** GDPR self-delete — wipes the user from Cognito and removes them from
   *  their household. Returns 400 if they're the only admin in a household
   *  with other members. */
  async deleteMe(): Promise<void> {
    await api.delete('/me');
  },

  /** GDPR data-portability export — the authoritative server-side artifact
   *  (profile, notification prefs, memberships, and the plants + tasks of
   *  every household the caller belongs to). Fetched as a blob so the auth
   *  token rides the interceptor; the caller triggers the download. */
  async exportMyData(): Promise<Blob> {
    const response = await api.get('/me/export', { responseType: 'blob' });
    return response.data as Blob;
  },
};
