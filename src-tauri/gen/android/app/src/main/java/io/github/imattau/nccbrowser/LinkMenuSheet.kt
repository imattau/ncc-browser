package io.github.imattau.nccbrowser

import android.app.Activity
import android.graphics.Color
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.widget.NestedScrollView
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/** Draws a [LinkMenu] as a sheet over the page, which stays where it was. */
object LinkMenuSheet {
  /**
   * `title` is the link's own text, which the page chooses; `address` is always shown
   * under it, so a link that says one thing and goes elsewhere can be seen for what it
   * is.
   */
  fun show(
    activity: Activity,
    menu: LinkMenu.Menu,
    title: String?,
    address: String,
    choose: (LinkMenu.Item) -> Unit,
  ): BottomSheetDialog {
    val dialog = BottomSheetDialog(activity)
    val density = activity.resources.displayMetrics.density
    fun dp(value: Int) = (value * density).toInt()

    val column = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, dp(12), 0, dp(12))
    }
    val textColor = themeColor(activity, android.R.attr.textColorPrimary)
    val quietColor = themeColor(activity, android.R.attr.textColorSecondary)

    val heading = title?.trim()?.replace(Regex("\\s+"), " ")?.take(160)?.takeIf { it.isNotEmpty() }
      ?: if (menu.isImage) "Image" else null
    if (heading != null && heading != address) {
      column.addView(TextView(activity).apply {
        text = heading
        textSize = 16f
        setTextColor(textColor)
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        setPadding(dp(24), dp(4), dp(24), 0)
      })
    }
    column.addView(TextView(activity).apply {
      // A picture written into the page has an "address" that is the picture itself.
      text = if (address.startsWith("data:")) "Part of this page" else address.take(600)
      textSize = 13f
      setTextColor(quietColor)
      maxLines = 3
      ellipsize = TextUtils.TruncateAt.END
      setPadding(dp(24), dp(4), dp(24), dp(10))
    })

    val ripple = TypedValue().also {
      activity.theme.resolveAttribute(android.R.attr.selectableItemBackground, it, true)
    }.resourceId
    for (section in menu.sections) {
      column.addView(
        View(activity).apply { setBackgroundColor(quietColor and 0x00FFFFFF or 0x33000000) },
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1).coerceAtLeast(1)).apply {
          topMargin = dp(4)
          bottomMargin = dp(4)
        },
      )
      for (item in section) {
        column.addView(TextView(activity).apply {
          text = item.label
          textSize = 16f
          setTextColor(textColor)
          gravity = Gravity.CENTER_VERTICAL
          minHeight = dp(52)
          setPadding(dp(24), dp(8), dp(24), dp(8))
          setBackgroundResource(ripple)
          isFocusable = true
          setOnClickListener {
            dialog.dismiss()
            choose(item)
          }
        })
      }
    }

    dialog.setContentView(NestedScrollView(activity).apply { addView(column) })
    // Every action visible at once, in landscape too; a half-open sheet hides some.
    dialog.behavior.skipCollapsed = true
    dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
    dialog.show()
    return dialog
  }

  private fun themeColor(activity: Activity, attribute: Int): Int {
    val value = TypedValue()
    if (!activity.theme.resolveAttribute(attribute, value, true)) return Color.GRAY
    return if (value.resourceId != 0) activity.getColor(value.resourceId) else value.data
  }
}
