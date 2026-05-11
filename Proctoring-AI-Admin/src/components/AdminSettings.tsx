import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { motion } from 'motion/react';
import {
  User,
  Shield,
  Mail,
  Lock,
  Save,
  AlertTriangle,
  Check,
  Upload
} from 'lucide-react';

export function AdminSettings() {
  const [activeSection, setActiveSection] = useState('profile');
  const [profileName, setProfileName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [profileDepartment, setProfileDepartment] = useState('Computer Science');
  const [profileRole, setProfileRole] = useState('Admin');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Security state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  const sections = [
    { id: 'profile', name: 'Profile', icon: User },
    { id: 'security', name: 'Security', icon: Shield },
  ];

  const loadProfileImage = async () => {
    try {
      const response = await api.get('auth/me/image', { responseType: 'blob' });
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfileImage(reader.result as string);
      };
      reader.readAsDataURL(response.data);
    } catch (err) {
      console.error('Failed to load profile image:', err);
      setProfileImage(null);
    }
  };

  const fetchAllSettings = async () => {
    try {
      setIsLoading(true);
      // Fetch Profile
      const profileRes = await api.get('auth/me');
      const { full_name, email, department, role, has_image } = profileRes.data;
      setProfileName(full_name || '');
      setProfileEmail(email || '');
      setProfileDepartment(department || 'Computer Science');
      setProfileRole(role || 'Admin');

      if (has_image) {
        await loadProfileImage();
      } else {
        setProfileImage(null);
      }


      setError(null);
    } catch (err: any) {
      console.error('Failed to fetch settings:', err);
      setError('Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAllSettings();
  }, []);

  const handleSave = async () => {
    try {
      if (activeSection === 'profile') {
        await api.patch('auth/me', {
          full_name: profileName,
          email: profileEmail,
          department: profileDepartment
        });
      }

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      setError(null);
    } catch (err: any) {
      console.error('Failed to save settings:', err);
      setError(err.response?.data?.detail || 'Failed to save settings. Please try again.');
    }
  };

  const handleUpdatePassword = async () => {
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    try {
      setIsUpdatingPassword(true);
      await api.post('auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword
      });

      setSaveSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error('Failed to update password:', err);
      setError(err.response?.data?.detail || 'Failed to update password. Please check your current password.');
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('Only JPEG and PNG images are allowed');
      return;
    }

    const formData = new FormData();
    formData.append('image', file);

    try {
      await api.patch('auth/me/image', formData);
      await loadProfileImage();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error('Image upload failed:', err);
      setError('Failed to upload image');
    }
  };

  const handleImageRemove = async () => {
    try {
      await api.delete('auth/me/image');
      setProfileImage(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error('Image removal failed:', err);
      setError('Failed to remove image');
    }
  };

  const handleReset = () => {
    fetchAllSettings();
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="mb-2 bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-4xl font-bold text-transparent">
              Settings
            </h1>
            <p className="text-slate-600">Configure your proctoring system preferences</p>
          </div>

          <button
            onClick={handleSave}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 px-6 py-3 font-semibold text-white shadow-lg transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
          >
            {saveSuccess ? (
              <>
                <Check className="h-5 w-5" />
                Saved Changes
              </>
            ) : (
              <>
                <Save className="h-5 w-5" />
                Save All Settings
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
          {/* Left Sidebar - Navigation */}
          <div className="lg:col-span-1">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
              <nav className="space-y-2">
                {sections.map((section, index) => {
                  const Icon = section.icon;
                  const isActive = activeSection === section.id;

                  return (
                    <motion.button
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      whileHover={{ x: 4 }}
                      className={`group relative w-full overflow-hidden rounded-lg p-3 text-left transition-all duration-300 ${isActive
                        ? 'bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-slate-900 shadow-md'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                        }`}
                    >
                      {/* Active indicator */}
                      {isActive && (
                        <motion.div
                          layoutId="activeSection"
                          className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-cyan-400 to-blue-500"
                          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                        />
                      )}

                      <div className="flex items-center gap-3">
                        <Icon
                          className={`h-5 w-5 transition-colors ${isActive ? 'text-cyan-600' : 'text-slate-400 group-hover:text-cyan-600'
                            }`}
                        />
                        <span className="text-sm font-medium">{section.name}</span>
                      </div>
                    </motion.button>
                  );
                })}
              </nav>
            </div>

            {/* System Status */}
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4">
              <div className="mb-2 flex items-center gap-2">
                <div className="relative">
                  <div className="h-3 w-3 rounded-full bg-green-500" />
                  <div className="absolute inset-0 h-3 w-3 animate-ping rounded-full bg-green-500 opacity-75" />
                </div>
                <span className="text-sm font-semibold text-green-900">All Systems Operational</span>
              </div>
              <p className="text-xs text-green-700">Last updated: 2 min ago</p>
            </div>
          </div>

          {/* Right Content Area */}
          <div className="lg:col-span-3">
            <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-lg">
              {/* Profile Section */}
              {activeSection === 'profile' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
                >
                  <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg">
                      <User className="h-6 w-6 text-white" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold text-slate-900">Profile Settings</h2>
                      <p className="text-sm text-slate-600">Manage your personal information</p>
                    </div>
                  </div>

                  {/* Profile Picture */}
                  <div>
                    <label className="mb-3 block text-sm font-medium text-slate-700">Profile Picture</label>
                    <div className="flex items-center gap-6">
                      <div className="relative flex-shrink-0">
                        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-gradient-to-br from-cyan-500 to-blue-600 shadow-xl ring-1 ring-slate-200">
                          {profileImage ? (
                            <img
                              src={profileImage}
                              alt="Profile"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-3xl font-bold text-white">
                              {profileName.split(' ').map(n => n[0]).join('').toUpperCase() || 'AD'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <input
                          type="file"
                          id="avatar-upload"
                          style={{ display: 'none' }}
                          accept="image/jpeg,image/png"
                          onChange={handleImageUpload}
                        />
                        <button
                          onClick={() => document.getElementById('avatar-upload')?.click()}
                          className="flex items-center gap-2 rounded-lg border border-cyan-600 bg-cyan-50 px-4 py-2 text-sm font-medium text-cyan-600 transition-all hover:bg-cyan-100"
                        >
                          <Upload className="h-4 w-4" />
                          Upload New
                        </button>
                        <button
                          onClick={handleImageRemove}
                          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Name */}
                  <div>
                    <label htmlFor="name" className="mb-2 block text-sm font-medium text-slate-700">
                      Full Name
                    </label>
                    <input
                      id="name"
                      type="text"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-900 transition-all focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    />
                  </div>

                  {/* Email */}
                  <div>
                    <label htmlFor="email" className="mb-2 block text-sm font-medium text-slate-700">
                      Email Address
                    </label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2">
                        <Mail className="h-5 w-5 text-slate-400" />
                      </div>
                      <input
                        id="email"
                        type="email"
                        value={profileEmail}
                        onChange={(e) => setProfileEmail(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white py-3 pl-11 pr-4 text-slate-900 transition-all focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      />
                    </div>
                  </div>

                  {/* Department */}
                  <div>
                    <label htmlFor="department" className="mb-2 block text-sm font-medium text-slate-700">
                      Department
                    </label>
                    <select
                      id="department"
                      value={profileDepartment}
                      onChange={(e) => setProfileDepartment(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-900 transition-all focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    >
                      <option value="Computer Science">Computer Science</option>
                      <option value="Mathematics">Mathematics</option>
                      <option value="Physics">Physics</option>
                      <option value="Chemistry">Chemistry</option>
                      <option value="Engineering">Engineering</option>
                    </select>
                  </div>

                  {/* Role */}
                  <div>
                    <label htmlFor="role" className="mb-2 block text-sm font-medium text-slate-700">
                      Role
                    </label>
                    <input
                      id="role"
                      type="text"
                      value={profileRole}
                      disabled
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600"
                    />
                  </div>
                </motion.div>
              )}

              {/* Security Section */}
              {activeSection === 'security' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
                >
                  <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-pink-600 shadow-lg">
                      <Shield className="h-6 w-6 text-white" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold text-slate-900">Security Settings</h2>
                      <p className="text-sm text-slate-600">Manage authentication and access control</p>
                    </div>
                  </div>

                  {/* Change Password */}
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">Current Password</label>
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2">
                        <Lock className="h-5 w-5 text-slate-400" />
                      </div>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Enter current password"
                        className="w-full rounded-lg border border-slate-300 bg-white py-3 pl-11 pr-4 text-slate-900 transition-all focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">New Password</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter new password"
                      className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-900 transition-all focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">Confirm New Password</label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                      className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-900 transition-all focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                    />
                  </div>

                  <button
                    onClick={handleUpdatePassword}
                    disabled={isUpdatingPassword}
                    className="rounded-lg border border-cyan-600 bg-cyan-50 px-6 py-2 text-sm font-medium text-cyan-600 transition-all hover:bg-cyan-100 disabled:opacity-50"
                  >
                    {isUpdatingPassword ? 'Updating...' : 'Update Password'}
                  </button>
                </motion.div>
              )}

              {/* Save Button - Always at bottom */}
              <div className="mt-8 flex items-center justify-between border-t border-slate-200 pt-6">
                <div>
                  {saveSuccess && (
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-2 text-sm font-medium text-green-600"
                    >
                      <Check className="h-4 w-4" />
                      Settings saved successfully!
                    </motion.div>
                  )}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleReset}
                    className="rounded-lg border border-slate-300 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50"
                  >
                    Reset to Defaults
                  </button>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleSave}
                    className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-6 py-3 font-semibold text-white shadow-lg shadow-cyan-500/30 transition-all hover:shadow-cyan-500/50"
                  >
                    <Save className="h-5 w-5" />
                    Save Changes
                  </motion.button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div >
  );
}
