package sh.paseo.selection

import android.content.Context
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.WeakHashMap

class PaseoTextSelectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoTextSelection")
    View(PaseoTextSelectionView::class) {
      Events("onSelect")
      Prop("actions") { view: PaseoTextSelectionView, actions: List<Map<String, String>> ->
        view.actions = actions
        view.post { view.attachCallbacks() }
      }
    }
  }
}

class PaseoTextSelectionView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onSelect by EventDispatcher()
  var actions: List<Map<String, String>> = emptyList()
  private val callbacks = WeakHashMap<TextView, SelectionCallback>()

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    // React Native owns child frames; LinearLayout would overwrite them.
    attachCallbacks()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    post { attachCallbacks() }
  }

  override fun onDetachedFromWindow() {
    callbacks.forEach { (text, callback) -> callback.restore(text) }
    callbacks.clear()
    super.onDetachedFromWindow()
  }

  fun attachCallbacks() {
    if (!isAttachedToWindow) return
    val retained = mutableSetOf<TextView>()
    if (actions.isNotEmpty()) visit(this, "text", retained)
    callbacks.keys.toList().filter { it !in retained }.forEach { text ->
      callbacks.remove(text)?.restore(text)
    }
  }

  private fun visit(view: View, path: String, retained: MutableSet<TextView>) {
    if (view !== this && view is PaseoTextSelectionView) return
    if (view is TextView && view.isTextSelectable && view !is android.widget.EditText) {
      retained.add(view)
      val callback = callbacks.getOrPut(view) { SelectionCallback(this, view.customSelectionActionModeCallback) }
      callback.surfaceId = path
      if (view.customSelectionActionModeCallback !== callback) {
        callback.original = view.customSelectionActionModeCallback
        view.customSelectionActionModeCallback = callback
      }
    }
    if (view is ViewGroup) for (index in 0 until view.childCount) {
      visit(view.getChildAt(index), "$path.$index", retained)
    }
  }

  private class SelectionCallback(
    val owner: PaseoTextSelectionView,
    var original: ActionMode.Callback?,
  ) : ActionMode.Callback2() {
    var surfaceId = "text"
    private val menuActions = mutableMapOf<MenuItem, String>()

    fun restore(text: TextView) {
      if (text.customSelectionActionModeCallback === this) text.customSelectionActionModeCallback = original
    }

    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
      if (original?.onCreateActionMode(mode, menu) == false) return false
      addActions(menu)
      return true
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
      val changed = original?.onPrepareActionMode(mode, menu) ?: false
      menuActions.keys.forEach { menu.removeItem(it.itemId) }
      addActions(menu)
      return changed || menuActions.isNotEmpty()
    }

    private fun addActions(menu: Menu) {
      menuActions.clear()
      owner.actions.forEachIndexed { index, action ->
        val id = action["id"] ?: return@forEachIndexed
        val title = action["title"] ?: return@forEachIndexed
        val item = menu.add(Menu.NONE, 0x5a710000 + index, Menu.NONE, title)
        menuActions[item] = id
      }
    }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
      val id = menuActions[item] ?: return original?.onActionItemClicked(mode, item) ?: false
      val textView = owner.callbacks.entries.firstOrNull { it.value === this }?.key ?: return false
      if (owner.actions.none { it["id"] == id }) return false
      val start = minOf(textView.selectionStart, textView.selectionEnd)
      val end = maxOf(textView.selectionStart, textView.selectionEnd)
      val text = textView.text.toString()
      if (start < 0 || end <= start || end > text.length) return false
      owner.onSelect(mapOf(
        "actionId" to id, "surfaceId" to surfaceId, "text" to text.substring(start, end),
        "start" to start, "end" to end,
        "prefix" to text.substring(maxOf(0, start - 64), start),
        "suffix" to text.substring(end, minOf(text.length, end + 64)),
      ))
      mode.finish()
      return true
    }

    override fun onDestroyActionMode(mode: ActionMode) {
      menuActions.clear()
      original?.onDestroyActionMode(mode)
    }

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: android.graphics.Rect) {
      val callback = original
      if (callback is ActionMode.Callback2) callback.onGetContentRect(mode, view, outRect)
      else super.onGetContentRect(mode, view, outRect)
    }
  }
}
