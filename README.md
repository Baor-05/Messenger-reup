# Messenger

Ứng dụng Messenger Desktop cho Windows, hỗ trợ nhiều tài khoản, chạy trên Electron/Chromium.

## Tính năng chính

- Quản lý nhiều tài khoản Messenger bằng session riêng.
- Chuyển nhanh giữa các tài khoản ở sidebar.
- Khóa app bằng PIN.
- Thông báo và badge tin nhắn chưa đọc.
- Chế độ sáng/tối, ghim cửa sổ, thu nhỏ xuống khay hệ thống.
- Hỗ trợ gọi điện/video call qua Messenger Web.

## Cài đặt và chạy

### Cách 1: Dành cho người sử dụng phổ thông

1. Tải file [Messeger.zip](https://github.com/Baor-05/Messenger-reup/releases/tag/Messeger) trong phần Releases.
2. Giải nén file `Messeger.zip`.
3. Mở file `Messeger.exe`.

### Cách 2: Dành cho DEV

Yêu cầu [Node.js LTS](https://nodejs.org/en).

```bash
npm install
npm start
```

## Build

```bash
npm run build
```

Hoặc build bản portable:

```bash
npm run build:portable
```

File build xuất hiện trong thư mục `dist/`.

## Lưu ý

Dữ liệu đăng nhập, cookies và session được lưu cục bộ theo profile trên máy đang chạy app.
