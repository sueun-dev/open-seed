/**
 * Snake Game — Input handler (keyboard + mobile buttons)
 */
(function (exports) {
  'use strict';

  var KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right'
  };

  function InputHandler(game, callbacks) {
    this.game = game;
    this.callbacks = callbacks || {};

    var self = this;

    document.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (self.callbacks.onStart) self.callbacks.onStart();
        return;
      }
      var dir = KEY_MAP[e.key];
      if (dir) {
        e.preventDefault();
        game.setDirection(dir);
      }
    });

    // Mobile buttons
    var buttons = document.querySelectorAll('#mobile-controls button[data-dir]');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var dir = btn.getAttribute('data-dir');
          if (dir) game.setDirection(dir);
        });
      })(buttons[i]);
    }

    // Tap overlay to start
    var overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.addEventListener('click', function () {
        if (self.callbacks.onStart) self.callbacks.onStart();
      });
    }
  }

  InputHandler.KEY_MAP = KEY_MAP;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = InputHandler;
  } else {
    exports.InputHandler = InputHandler;
  }
})(typeof window !== 'undefined' ? window : this);
