package bypass.whitelist

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate
import bypass.whitelist.util.Prefs
import bypass.whitelist.util.ThemeMode
import com.vk.id.VKID

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        applyTheme(Prefs.themeMode)
        if (BuildConfig.VK_POC_CONFIGURED) {
            // The POC never enables SDK diagnostics: auth/token material must not
            // enter Logcat, the app's file log, or a user-visible error.
            VKID.logsEnabled = false
            VKID.init(this)
        }
    }

    companion object {
        fun applyTheme(mode: ThemeMode) {
            val target = when (mode) {
                ThemeMode.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                ThemeMode.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                ThemeMode.DARK -> AppCompatDelegate.MODE_NIGHT_YES
            }
            AppCompatDelegate.setDefaultNightMode(target)
        }
    }
}
