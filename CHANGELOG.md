# Changelog

## Messenger v1.1.4

- Thêm menu dọn cache để giảm dung lượng và xử lý lỗi session/tải trang.
- Cải thiện cập nhật tự động: trạng thái bản mới trên tray, changelog trong cửa sổ cập nhật, nút "Cài ngay" và "Cài sau".
- Thêm sleep profile nền để giảm RAM khi không dùng nhiều tài khoản cùng lúc.

## Messenger v1.1.3

- Sửa lỗi tin nhắn bị kẹt ở trạng thái "Đang gửi" khi bật chặn "Đang nhập".
- Thu hẹp rule chặn typing để không bắt nhầm telemetry `send_typing_indicators`.
- Bổ sung test chống hồi quy cho payload telemetry không phải trạng thái gõ thật.

## Messenger v1.1.2

- Chặn chính xác trạng thái "Đã xem" gửi qua Messenger Lightspeed WebSocket.
- Chặn chính xác trạng thái "Đang nhập" gửi qua WebSocket, kể cả payload JSON bị escape.
- Bổ sung hook cho Worker/SharedWorker để bảo mật vẫn hoạt động khi Messenger chạy nền xử lý trong worker.
- Đồng bộ tên file cài đặt Windows thành `MessengerSetup`.
- Bổ sung test cho payload WebSocket thực tế và worker privacy hook.

## Messenger v1.1.1

- Hiển thị thanh tiến trình và phần trăm khi tải bản cập nhật.
- Hiển thị dung lượng đã tải, tổng dung lượng và tốc độ tải.
- Đồng bộ tiến trình cập nhật với thanh taskbar Windows.

## Messenger v1.0

Phiên bản đầu tiên của ứng dụng Messenger Desktop cho Windows.

### Tính năng chính

- Hỗ trợ đăng nhập và sử dụng nhiều tài khoản Messenger cùng lúc.
- Tách session, cookies và cache riêng cho từng tài khoản.
- Sidebar quản lý tài khoản, đổi tên, xóa và đăng nhập lại nhanh.
- Hỗ trợ thông báo, badge tin nhắn chưa đọc và System Tray.
- Có phím tắt mở/ẩn ứng dụng.
- Hỗ trợ chế độ sáng/tối, ghim cửa sổ và toàn màn hình.
- Hỗ trợ khóa ứng dụng bằng mã PIN.
- Hỗ trợ gọi điện và video call qua Messenger Web.
- Tối ưu giao diện Messenger trong cửa sổ desktop.

### Ghi chú

- Dữ liệu đăng nhập được lưu cục bộ trên máy.
- Ứng dụng chạy trên Electron/Chromium.
