document.addEventListener('DOMContentLoaded', () => {
    // Обработка формы регистрации
    const registrationForm = document.getElementById('registrationForm');
    if (registrationForm) {
        registrationForm.addEventListener('submit', (event) => {
            event.preventDefault(); // Предотвращаем стандартную отправку формы

            // Здесь в реальном приложении была бы отправка данных на сервер
            // и обработка ответа. Для статики просто перенаправляем.

        });
    }

    
    // Показываем имя пользователя и роль на главной странице
    const userInfoBlock = document.getElementById('userInfo');
    const currentUser = JSON.parse(localStorage.getItem('currentUser'));
    if (userInfoBlock && currentUser) {
        userInfoBlock.textContent = `Вы вошли как: ${currentUser.username} (${currentUser.role || 'роль не указана'})`;
    }
});
