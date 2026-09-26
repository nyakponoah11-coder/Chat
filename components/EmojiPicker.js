'use client';

const EMOJI = [
  '😀','😂','😍','😘','😊','😉','😢','😭','😡','😱',
  '👍','👎','👏','🙏','💪','🤝','✌️','👋','🔥','💯',
  '❤️','💔','💕','⭐','🎉','🎂','🍕','☕','🌙','☀️',
];

const STICKERS = ['🐶','🐱','🐼','🦁','🐸','🌈','🎈','🚀','👑','💃'];

export default function EmojiPicker({ onEmoji, onSticker, onClose }) {
  return (
    <div className="emoji-picker" onMouseLeave={onClose}>
      <div className="emoji-section-label">Emoji</div>
      <div className="emoji-grid">
        {EMOJI.map((e) => (
          <button key={e} className="emoji-btn" onClick={() => onEmoji(e)}>{e}</button>
        ))}
      </div>
      <div className="emoji-section-label">Stickers</div>
      <div className="emoji-grid">
        {STICKERS.map((s) => (
          <button key={s} className="emoji-btn sticker-btn" onClick={() => onSticker(s)}>{s}</button>
        ))}
      </div>
    </div>
  );
}
